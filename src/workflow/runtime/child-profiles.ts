import type { ChildOptions, WorkflowDeclaration } from './child-model.js';
import type { ClaudeOptions, CodexOptions, ExecutionPolicy } from './model.js';
import type { CapabilityManifest, ProfileOverride, ResolvedProfile } from './profiles-model.js';
import { digest } from './json.js';
import { profileGrantDigest, requireGrant, resolveCapabilities } from './profiles.js';

/** A live child capability boundary; private environment values never enter frame records. @internal */
export interface ChildCapabilities {
  readonly manifest: CapabilityManifest;
  readonly grants: readonly string[];
  readonly pins: Readonly<Record<string, string>>;
  readonly overrides: readonly ProfileOverride[];
  readonly check: (
    name: string,
    provider: 'claude' | 'codex',
    call: ClaudeOptions | CodexOptions,
  ) => void;
  readonly limits: <T extends ExecutionPolicy>(name: string, policy: T) => T;
}

function narrows(rule: string, parent: string): boolean {
  return (
    rule === parent ||
    (!parent.includes('(') && rule.startsWith(`${parent}(`) && rule.endsWith(')'))
  );
}

function subset(child: ResolvedProfile, parent: ResolvedProfile, label: string): void {
  const reject = (field: string): never => {
    throw new Error(
      `Child profile ${label} exceeds parent profile ${parent.name}: ${field}. Delegate a sufficient parent role explicitly.`,
    );
  };
  if (!child.claude.tools.every((tool) => parent.claude.tools.includes(tool))) reject('tools');
  if (
    !child.claude.allowedTools.every((rule) =>
      parent.claude.allowedTools.some((allowed) => narrows(rule, allowed)),
    )
  )
    reject('allowedTools');
  if (child.codex.sandbox === 'workspace-write' && parent.codex.sandbox !== 'workspace-write')
    reject('sandbox');
  for (const provider of ['claude', 'codex'] as const) {
    const wanted = child[provider];
    const allowed = parent[provider];
    if (wanted.isolation === 'inherit' && allowed.isolation !== 'inherit')
      reject(`${provider}.isolation`);
    if (!(wanted.addDirs ?? []).every((path) => allowed.addDirs?.includes(path)))
      reject(`${provider}.addDirs`);
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
        reject(`${provider}.${field}`);
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
  const checkProfile = (name: string, role: ResolvedProfile): void => {
    const ceiling = bound(name);
    subset(role, ceiling, `${definition.name}.${name}`);
    requireGrant(ceiling, parentGrants, parentPins);
  };
  for (const name of new Set([
    manifest.defaultProfile,
    ...Object.keys(definition.profiles ?? {}),
  ])) {
    const role = manifest.profiles[name];
    if (role) checkProfile(name, role);
  }
  const delegated: Record<string, ResolvedProfile> = {};
  for (const [name, role] of Object.entries(manifest.profiles)) {
    // Remove unavailable optional built-ins as well: a grandchild must not inherit phantom authority.
    try {
      checkProfile(name, role);
    } catch {
      continue;
    }
    const ceiling = bound(name);
    const inherited: ResolvedProfile = {
      ...role,
      claude: {
        ...role.claude,
        ...(role.claude.model === undefined && ceiling.claude.model !== undefined
          ? { model: ceiling.claude.model }
          : {}),
        ...(role.claude.effort === undefined && ceiling.claude.effort !== undefined
          ? { effort: ceiling.claude.effort }
          : {}),
      },
      codex: {
        ...role.codex,
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
    check(name, provider, call) {
      const role = manifest.profiles[name];
      if (!role) throw new Error(`Unknown child profile ${name}.`);
      checkProfile(name, { ...role, [provider]: { ...role[provider], ...call } });
    },
    limits(name, policy) {
      const ceiling = bound(name);
      const result = { ...policy };
      for (const field of ['timeoutMs', 'maxTurns', 'maxBudgetUsd'] as const)
        if (ceiling[field] !== undefined)
          Object.assign(result, {
            [field]: Math.min(result[field] ?? ceiling[field], ceiling[field]),
          });
      return result;
    },
  };
}
