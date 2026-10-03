import type { HarnessDeclaration } from './harness-model.js';
import type { ChildOptions, WorkflowDeclaration } from './child-model.js';
import type { AgentOptions, ExecutionPolicy } from './model.js';
import type {
  AgentProfile,
  CapabilityManifest,
  ProfileLimits,
  ProfileOverride,
  ResolvedProfile,
} from './profiles-model.js';
import { digest } from './json.js';
import {
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
    call: AgentOptions,
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

/** The effective denial policy a provider call gets from a profile, before call options. */
function denialPolicy(profile: ResolvedProfile, provider: 'claude' | 'codex'): 'warn' | 'fail' {
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
  const profiles = definition.profiles ?? {};
  const seen = new Set<string>();
  for (let current: string | undefined = name; current !== undefined && !seen.has(current);) {
    seen.add(current);
    const layer: AgentProfile | undefined = Object.hasOwn(profiles, current)
      ? profiles[current]
      : undefined;
    if (!layer) break;
    if (layer.onPermissionDenied !== undefined) return layer.onPermissionDenied;
    current = layer.extends;
  }
  return definition.defaults?.onPermissionDenied;
}

function subset(child: ResolvedProfile, parent: ResolvedProfile, label: string): void {
  const reject = (field: string): never => {
    throw new Error(
      `Child profile ${label} exceeds parent profile ${parent.name}: ${field}. Delegate a sufficient parent role explicitly.`,
    );
  };
  const rank = { none: 0, read: 1, write: 2, exec: 3 };
  for (const [name, access] of Object.entries(child.harnessAccess ?? {})) {
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
    !(parent.claude.disallowedTools ?? []).every((rule) =>
      child.claude.disallowedTools?.includes(rule),
    )
  )
    reject('disallowedTools');
  if (parent.claude.strictMcpConfig === true && child.claude.strictMcpConfig !== true)
    reject('strictMcpConfig');
  // Failing on reported denials is a parent guarantee; a child may only keep it.
  for (const provider of ['claude', 'codex'] as const)
    if (denialPolicy(parent, provider) === 'fail' && denialPolicy(child, provider) !== 'fail')
      reject('onPermissionDenied');
}

/** Resolve declared child needs and check them against concrete parent roles before child effects. @internal */
export function delegateCapabilities(
  definition: WorkflowDeclaration,
  parent: CapabilityManifest,
  parentGrants: readonly string[],
  parentPins: Readonly<Record<string, string>>,
  parentOverrides: readonly ProfileOverride[],
  options: ChildOptions,
): ChildCapabilities {
  let manifest = resolveCapabilities(definition);
  const mapping = options.profiles ?? {};
  for (const name of Object.keys(mapping))
    if (!Object.hasOwn(manifest.profiles, name))
      throw new Error(`Unknown child profile mapping: ${name}.`);
  const bounds = new Map<string, ResolvedProfile>();
  const grants: string[] = [];
  const pins: Record<string, string> = {};
  const overrides: ProfileOverride[] = [];
  const bound = (name: string): ResolvedProfile => {
    const cached = bounds.get(name);
    if (cached) return cached;
    const parentName = mapping[name] ?? name;
    const role = parent.profiles[parentName];
    if (!Object.hasOwn(parent.profiles, parentName) || !role)
      throw new Error(
        `Child ${definition.name} profile ${name} has no parent grant ${parentName}; declare a parent role or map it with options.profiles.`,
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
    role: ResolvedProfile,
    ceiling: ResolvedProfile,
  ): ResolvedProfile => {
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
  const checkProfile = (name: string, role: ResolvedProfile): ResolvedProfile => {
    const ceiling = bound(name);
    const inherited = inheritDenials(name, role, ceiling);
    subset(inherited, ceiling, `${definition.name}.${name}`);
    requireGrant(ceiling, parentGrants, parentPins);
    return inherited;
  };
  for (const name of new Set([
    manifest.defaultProfile,
    ...Object.keys(definition.profiles ?? {}),
  ])) {
    const role = manifest.profiles[name];
    if (role) checkProfile(name, role);
  }
  const delegated: Record<string, ResolvedProfile> = {};
  for (const [name, declared] of Object.entries(manifest.profiles)) {
    // Remove unavailable optional built-ins as well: a grandchild must not inherit phantom authority.
    let role: ResolvedProfile;
    try {
      role = checkProfile(name, declared);
    } catch {
      continue;
    }
    const ceiling = bound(name);
    // Clamp to the effective ceiling here too: a grandchild otherwise treats the child's larger
    // declared limit as its own ceiling and can exceed the root's cap.
    const clamped = clampLimits(role, ceiling);
    const inherited: ResolvedProfile = {
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
        ...(role.codex.reasoningEffort === undefined && ceiling.codex.reasoningEffort !== undefined
          ? { reasoningEffort: ceiling.codex.reasoningEffort }
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
      if (!role) throw new Error(`Unknown child profile ${name}.`);
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
