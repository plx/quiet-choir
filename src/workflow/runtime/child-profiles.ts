import type { HarnessDeclaration } from './harness-model.js';
import type { ChildOptions, WorkflowDeclaration } from './child-model.js';
import type { ExecutionPolicy } from './model.js';
import type {
  CapabilityManifest,
  ProfileLimits,
  ProfileOverride,
  ResolvedRole,
  RoleLayer,
  RoleRequest,
} from './profiles-model.js';
import { digest } from './json.js';
import { compileRoster } from './roster.js';
import {
  declaredRoleNames,
  profileGrantDigest,
  requireGrant,
  resolveCapabilities,
  registeredCapabilities,
} from './profiles.js';

/** A live child capability boundary; private environment values never enter frame records. @internal */
export interface ChildCapabilities {
  readonly manifest: CapabilityManifest;
  readonly grants: readonly string[];
  readonly pins: Readonly<Record<string, string>>;
  readonly overrides: readonly ProfileOverride[];
  readonly check: (
    name: string,
    harness: string,
    call: RoleRequest,
    definition?: HarnessDeclaration,
  ) => void;
  readonly limits: <T extends ExecutionPolicy>(name: string, policy: T) => T;
}

/** Clamp resource limit fields to a ceiling, keeping an undefined ceiling field unconstrained. */
function clampLimits<T extends ProfileLimits>(values: T, ceiling: ProfileLimits): T {
  const result = { ...values };
  for (const field of ['timeoutMs', 'idleTimeoutMs', 'maxTurns', 'maxBudgetUsd'] as const)
    if (ceiling[field] !== undefined)
      Object.assign(result, {
        [field]: Math.min(result[field] ?? ceiling[field], ceiling[field]),
      });
  return result;
}

function narrows(rule: string, parent: string): boolean {
  return (
    rule === parent ||
    (!parent.includes('(') && rule.startsWith(`${parent}(`) && rule.endsWith(')'))
  );
}

/** The effective denial policy a provider call gets from a role, before call options. */
function denialPolicy(profile: ResolvedRole, provider: 'claude' | 'codex'): 'warn' | 'fail' {
  return (
    (provider === 'claude' ? profile.claude.onPermissionDenied : undefined) ??
    profile.onPermissionDenied ??
    'warn'
  );
}

/** A child's own top-level denial policy, ignoring the resolver's implicit warn default. */
function declaredDenialPolicy(
  definition: WorkflowDeclaration,
  name: string,
): 'warn' | 'fail' | undefined {
  // Roster entries are the declared roles (#579, #726); their own policy sits in the pinned block.
  const roles = compileRoster(definition).profiles;
  const layer: RoleLayer | undefined = Object.hasOwn(roles, name) ? roles[name] : undefined;
  return layer?.onPermissionDenied ?? definition.defaults?.onPermissionDenied;
}

function subset(child: ResolvedRole, parent: ResolvedRole, label: string): void {
  const reject = (field: string): never => {
    throw new Error(
      `Child role ${label} exceeds parent role ${parent.name}: ${field}. Delegate a sufficient parent roster entry explicitly.`,
    );
  };
  const rank = { none: 0, read: 1, write: 2, exec: 3 };
  // A roster entry runs only on its pinned harness, so another harness's block neither grants it
  // anything nor binds it: its blocks there stay at the text baseline.
  const runs = (harness: string): boolean =>
    child.harness === undefined || child.harness === harness;
  for (const [name, access] of Object.entries(child.harnessAccess ?? {})) {
    if (!runs(name)) continue;
    if (rank[access] > rank[parent.harnessAccess?.[name] ?? 'none']) reject(`${name}.access`);
    const wanted = child.harnessCapabilities?.[name] ?? {};
    const allowed = parent.harnessCapabilities?.[name] ?? {};
    if (digest(wanted) !== digest(allowed)) reject(`${name}.capabilities`);
  }
  if (!child.claude.tools.every((tool) => parent.claude.tools.includes(tool))) reject('tools');
  if (
    !child.claude.allowedTools.every((rule) =>
      parent.claude.allowedTools.some((allowed) => narrows(rule, allowed)),
    )
  )
    reject('allowedTools');
  if (child.codex.sandbox === 'workspace-write' && parent.codex.sandbox !== 'workspace-write')
    reject('sandbox');
  for (const harness of ['claude', 'codex'] as const) {
    const wanted = child[harness];
    const allowed = parent[harness];
    if (wanted.isolation === 'inherit' && allowed.isolation !== 'inherit')
      reject(`${harness}.isolation`);
    // Literal membership is transitive: each level is checked against its parent's delegated roles.
    if (!(wanted.addDirs ?? []).every((path) => allowed.addDirs?.includes(path)))
      reject(`${harness}.addDirs`);
    // Native configuration is opaque: only exactly delegated escape hatches can cross the boundary.
    for (const field of [
      'plugins',
      'agent',
      'agents',
      'mcpServers',
      'settings',
      'harnessProfile',
      'config',
      'extraArgs',
      'env',
      'networkAccess',
      'permissionMode',
    ] as const) {
      const childValue = (wanted as unknown as Record<string, unknown>)[field];
      const parentValue = (allowed as unknown as Record<string, unknown>)[field];
      if (childValue !== undefined && digest(childValue) !== digest(parentValue ?? null))
        reject(`${harness}.${field}`);
    }
  }
  if (
    runs('claude') &&
    !(parent.claude.disallowedTools ?? []).every((rule) =>
      child.claude.disallowedTools?.includes(rule),
    )
  )
    reject('disallowedTools');
  if (
    runs('claude') &&
    parent.claude.strictMcpConfig === true &&
    child.claude.strictMcpConfig !== true
  )
    reject('strictMcpConfig');
  // Failing on reported denials is a parent guarantee; a child may only keep it.
  for (const provider of ['claude', 'codex'] as const)
    if (
      runs(provider) &&
      denialPolicy(parent, provider) === 'fail' &&
      denialPolicy(child, provider) !== 'fail'
    )
      reject('onPermissionDenied');
}

/**
 * Hold a child to a pinned ceiling's harness and access: a roster entry delegates authority on its
 * own harness only, so a child role on another harness, or above the entry's access, is refused.
 */
function pinned(child: ResolvedRole, parent: ResolvedRole, label: string): void {
  if (parent.harness === undefined) return;
  const rank = { none: 0, read: 1, write: 2, exec: 3 };
  const reject = (field: string): never => {
    throw new Error(
      `Child role ${label} exceeds parent role ${parent.name}: ${field}. Delegate a sufficient parent roster entry explicitly.`,
    );
  };
  if (child.harness !== parent.harness)
    reject(
      `harness (${child.harness ?? 'unpinned'}; the parent role is pinned to ${parent.harness})`,
    );
  if (rank[child.access] > rank[parent.access]) reject('access');
}

/**
 * Resolve declared child needs and, under `requireGrants`, check them against concrete parent roles
 * before child effects. `addDirs` delegate by literal membership in the parent role's; the parent's
 * roles were themselves checked against their parents', so this bounds every descendant. Without
 * `requireGrants` (ADR 0063 §5) the child's roles are its own: no parent role is looked up,
 * compared, clamped or granted, `options.profiles` is ignored, and the parent's override rules pass
 * through unchanged. @internal
 */
export function delegateCapabilities(
  definition: WorkflowDeclaration,
  parent: CapabilityManifest,
  parentGrants: readonly string[],
  parentPins: Readonly<Record<string, string>>,
  parentOverrides: readonly ProfileOverride[],
  options: ChildOptions,
  requireGrants: boolean,
): ChildCapabilities {
  let manifest = resolveCapabilities(definition, { requireGrants });
  if (!requireGrants)
    return {
      manifest,
      grants: [],
      pins: {},
      overrides: parentOverrides,
      check() {
        // No ceiling to check against: the child's own strictProfiles still governs its calls.
      },
      limits: (_name, policy) => policy,
    };
  const mapping = options.profiles ?? {};
  for (const name of Object.keys(mapping))
    if (!Object.hasOwn(manifest.profiles, name))
      throw new Error(`Unknown child role mapping: ${name}.`);
  const bounds = new Map<string, ResolvedRole>();
  // Own-key lookups only: roles named toString or valueOf must not read Object.prototype members.
  const parentNameOf = (name: string): string =>
    (Object.hasOwn(mapping, name) ? mapping[name] : name) ?? name;
  const grants: string[] = [];
  const pins: Record<string, string> = {};
  const overrides: ProfileOverride[] = [];
  const bound = (name: string): ResolvedRole => {
    const cached = bounds.get(name);
    if (cached) return cached;
    const parentName = parentNameOf(name);
    const role = parent.profiles[parentName];
    if (!Object.hasOwn(parent.profiles, parentName) || !role)
      throw new Error(
        `Child ${definition.name} role ${name} has no parent grant ${parentName}; declare a parent roster entry or map it with options.profiles.`,
      );
    const limits = { ...role };
    for (const rule of parentOverrides)
      if (rule.profile === '*' || rule.profile === parentName) {
        const values = { ...rule };
        Reflect.deleteProperty(values, 'profile');
        Object.assign(limits, values);
        overrides.push({ ...values, profile: name });
      }
    bounds.set(name, limits);
    return limits;
  };
  // An omitted child policy inherits a failing ceiling instead of the resolver's default warn;
  // an explicit weaker policy is left in place so the subset check refuses it.
  const inheritDenials = (
    name: string,
    role: ResolvedRole,
    ceiling: ResolvedRole,
  ): ResolvedRole => {
    if (declaredDenialPolicy(definition, name) !== undefined) return role;
    return {
      ...role,
      ...(ceiling.onPermissionDenied === 'fail' ? { onPermissionDenied: 'fail' as const } : {}),
      ...(role.claude.onPermissionDenied === undefined &&
      ceiling.claude.onPermissionDenied === 'fail'
        ? { claude: { ...role.claude, onPermissionDenied: 'fail' as const } }
        : {}),
    };
  };
  const checkProfile = (name: string, role: ResolvedRole): ResolvedRole => {
    const ceiling = bound(name);
    const inherited = inheritDenials(name, role, ceiling);
    const label = `${definition.name}.${name}`;
    pinned(inherited, ceiling, label);
    subset(inherited, ceiling, label);
    requireGrant(ceiling, parentGrants, parentPins);
    return inherited;
  };
  for (const name of new Set([manifest.defaultProfile, ...declaredRoleNames(definition)])) {
    const role = manifest.profiles[name];
    if (role) checkProfile(name, role);
  }
  const delegated: Record<string, ResolvedRole> = {};
  for (const [name, declared] of Object.entries(manifest.profiles)) {
    // Remove unavailable roles as well: a grandchild must not inherit phantom authority.
    let role: ResolvedRole;
    try {
      role = checkProfile(name, declared);
    } catch {
      continue;
    }
    const ceiling = bound(name);
    // Clamp to the effective ceiling here too: a grandchild otherwise treats the child's larger
    // declared limit as its own ceiling and can exceed the root's cap.
    const clamped = clampLimits(role, ceiling);
    const inherited: ResolvedRole = {
      ...clamped,
      ...(clamped.harnesses === undefined
        ? {}
        : {
            harnesses: Object.fromEntries(
              Object.entries(clamped.harnesses).map(([harness, controls]) => {
                const model = ceiling.harnesses?.[harness]?.['model'];
                return [
                  harness,
                  {
                    ...controls,
                    ...(controls['model'] === undefined && typeof model === 'string'
                      ? { model }
                      : {}),
                  },
                ];
              }),
            ),
          }),
      claude: {
        ...clamped.claude,
        ...(role.claude.model === undefined && ceiling.claude.model !== undefined
          ? { model: ceiling.claude.model }
          : {}),
        ...(role.claude.effort === undefined && ceiling.claude.effort !== undefined
          ? { effort: ceiling.claude.effort }
          : {}),
      },
      codex: {
        ...clamped.codex,
        ...(role.codex.model === undefined && ceiling.codex.model !== undefined
          ? { model: ceiling.codex.model }
          : {}),
        ...(role.codex.effort === undefined && ceiling.codex.effort !== undefined
          ? { effort: ceiling.codex.effort }
          : {}),
      },
    };
    delegated[name] = inherited;
    grants.push(name);
    pins[name] = profileGrantDigest(inherited);
  }
  manifest = {
    ...manifest,
    profiles: delegated,
    defaults: delegated[manifest.defaultProfile] ?? manifest.defaults,
  };
  return {
    manifest,
    grants,
    pins,
    overrides,
    check(name, harness, call, definition) {
      const role = manifest.profiles[name];
      if (!role) throw new Error(`Unknown child role ${name}.`);
      if (harness === 'claude' || harness === 'codex') {
        checkProfile(name, { ...role, [harness]: { ...role[harness], ...call } });
      } else {
        if (!definition) throw new Error(`Missing harness definition ${harness}.`);
        const { access, controls } = registeredCapabilities(definition, call);
        checkProfile(name, {
          ...role,
          harnessAccess: { ...role.harnessAccess, [harness]: access },
          harnessCapabilities: { ...role.harnessCapabilities, [harness]: controls },
        });
      }
    },
    limits(name, policy) {
      return clampLimits(policy, bound(name));
    },
  };
}
