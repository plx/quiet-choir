import { z } from 'zod';
import type { ClaudeOptions, CodexOptions } from './model.js';
import type {
  AccessClass,
  AgentDefaults,
  AgentProfile,
  CapabilityManifest,
  ProfileOverride,
  ResolvedProfile,
} from './profiles-model.js';
import { digest, jsonValue } from './json.js';

const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
const limits = {
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxBudgetUsd: z.number().positive().optional(),
};
const fields = {
  ...limits,
  description: z.string().optional(),
  access: z.enum(['none', 'read', 'write', 'exec']).optional(),
  expectsToolUse: z.boolean().optional(),
  onPermissionDenied: z.enum(['warn', 'fail']).optional(),
  claude: z
    .strictObject({
      model: z.string().min(1).optional(),
      tools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_*.-]*$/u)).optional(),
      allowedTools: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  codex: z
    .strictObject({
      model: z.string().min(1).optional(),
      sandbox: z.enum(['read-only', 'workspace-write']).optional(),
      reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
      skipGitRepoCheck: z.boolean().optional(),
      structuredOutput: z.enum(['strict', 'compat']).optional(),
    })
    .optional(),
};
const profileSchema = z.strictObject({ ...fields, extends: nameSchema.optional() });
/** Checkpoint/launch profile rule validator. @internal */
export const profileOverrideSchema = z
  .strictObject({ profile: z.union([nameSchema, z.literal('*')]), ...limits })
  .refine(
    (rule) =>
      rule.timeoutMs !== undefined ||
      rule.maxTurns !== undefined ||
      rule.maxBudgetUsd !== undefined,
    'A profile override must set a limit.',
  );
/** Checkpoint/launch grant validator. @internal */
export const grantsSchema = z.array(nameSchema);

const builtins: Record<string, AgentProfile> = {
  text: {
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    timeoutMs: 300_000,
    claude: { tools: [] },
    codex: { sandbox: 'read-only' },
  },
  readonly: {
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
    claude: { tools: ['Read', 'Grep', 'Glob'] },
    codex: { sandbox: 'read-only' },
  },
  edit: {
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
    claude: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
    codex: { sandbox: 'workspace-write' },
  },
};
const rank: Record<AccessClass, number> = { none: 0, read: 1, write: 2, exec: 3 };

/** Infer exposed tool access conservatively; unknown/MCP tools require exec. @internal */
export function toolAccess(tools: readonly string[]): AccessClass {
  let access: AccessClass = 'none';
  for (const tool of tools) {
    const base = tool.split('(')[0];
    const next = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(base ?? '')
      ? 'read'
      : ['Edit', 'Write', 'NotebookEdit'].includes(base ?? '')
        ? 'write'
        : 'exec';
    if (rank[next] > rank[access]) access = next;
  }
  return access;
}

/** Explicit allowedTools can only select exposed tools or narrow a bare tool to a rule. @internal */
export function checkAllowedTools(tools: readonly string[], allowed: readonly string[]): void {
  for (const rule of allowed) {
    if (
      !tools.some(
        (tool) =>
          rule === tool ||
          (!tool.includes('(') && rule.startsWith(`${tool}(`) && rule.endsWith(')')),
      )
    )
      throw new Error(`allowedTools rule ${JSON.stringify(rule)} does not narrow an exposed tool.`);
  }
}

function merge(base: AgentProfile, layer: AgentProfile): AgentProfile {
  const claude = { ...base.claude, ...layer.claude };
  // An explicit new exposure list invalidates inherited permissions; infer from the new list.
  if (layer.claude?.tools !== undefined && layer.claude.allowedTools === undefined)
    delete claude.allowedTools;
  return { ...base, ...layer, claude, codex: { ...base.codex, ...layer.codex } };
}

/** Resolve and validate capability declarations without executing the workflow body. */
export function capabilityManifest(definition: {
  readonly defaults?: AgentDefaults;
  readonly profiles?: Readonly<Record<string, AgentProfile>>;
  readonly strictProfiles?: boolean;
}): CapabilityManifest {
  const config = z
    .strictObject({
      defaults: z.strictObject({ ...fields, profile: nameSchema.optional() }).optional(),
      profiles: z.record(nameSchema, profileSchema).optional(),
      strictProfiles: z.boolean().optional(),
    })
    .parse(
      jsonValue({
        ...(definition.defaults === undefined ? {} : { defaults: definition.defaults }),
        ...(definition.profiles === undefined ? {} : { profiles: definition.profiles }),
        ...(definition.strictProfiles === undefined
          ? {}
          : { strictProfiles: definition.strictProfiles }),
      }),
    ) as {
    defaults?: AgentDefaults;
    profiles?: Record<string, AgentProfile>;
    strictProfiles?: boolean;
  };
  const declared = config.profiles ?? {};
  for (const name of Object.keys(declared)) {
    if (
      Object.hasOwn(builtins, name) ||
      ['all', 'none', 'read', 'write', 'exec', 'constructor', 'prototype', '__proto__'].includes(
        name,
      )
    )
      throw new Error(`Reserved profile name: ${name}.`);
  }
  const profiles: Record<string, ResolvedProfile> = Object.create(null) as Record<
    string,
    ResolvedProfile
  >;
  const chain = (
    name: string,
    seen: string[] = [],
  ): { preset: AgentProfile; layers: AgentProfile[] } => {
    if (seen.includes(name))
      throw new Error(`Profile inheritance cycle: ${[...seen, name].join(' -> ')}.`);
    const builtin = builtins[name];
    if (Object.hasOwn(builtins, name) && builtin) return { preset: builtin, layers: [] };
    const layer = declared[name];
    if (!Object.hasOwn(declared, name) || !layer) throw new Error(`Unknown profile: ${name}.`);
    const parent = chain(layer.extends ?? 'text', [...seen, name]);
    return { preset: parent.preset, layers: [...parent.layers, layer] };
  };
  for (const name of [...Object.keys(builtins), ...Object.keys(declared)]) {
    const { preset, layers } = chain(name);
    const defaults = { ...config.defaults };
    delete defaults.profile;
    const combined = layers.reduce(merge, merge(preset, defaults));
    const assertion = combined.access;
    const data = { ...combined };
    delete data.extends;
    delete data.access;
    const tools = data.claude?.tools ?? [];
    const allowedTools = data.claude?.allowedTools ?? tools;
    checkAllowedTools(tools, allowedTools);
    const claudeAccess = toolAccess(tools);
    const sandbox = data.codex?.sandbox ?? 'read-only';
    const codexAccess = sandbox === 'workspace-write' ? 'write' : 'read';
    const access = rank[claudeAccess] > rank[codexAccess] ? claudeAccess : codexAccess;
    // A parent's assertion describes the parent, not every descendant that replaces tools.
    const ownAssertion = declared[name]?.access ?? (layers.length ? undefined : assertion);
    if (ownAssertion !== undefined && ownAssertion !== access)
      throw new Error(
        `Profile ${name} declares access ${ownAssertion}, but its tools/sandbox infer ${access}.`,
      );
    profiles[name] = {
      ...data,
      name,
      access,
      claudeAccess,
      codexAccess,
      expectsToolUse: data.expectsToolUse ?? access !== 'none',
      onPermissionDenied: data.onPermissionDenied ?? 'warn',
      claude: { ...data.claude, tools: [...tools], allowedTools: [...allowedTools] },
      codex: { ...data.codex, sandbox },
    };
  }
  const defaultProfile = config.defaults?.profile ?? 'text';
  const defaults = profiles[defaultProfile];
  if (!Object.hasOwn(profiles, defaultProfile) || !defaults)
    throw new Error(`Unknown default profile: ${defaultProfile}.`);
  return {
    strictProfiles: config.strictProfiles ?? true,
    defaultProfile,
    defaults,
    profiles,
    requiredGrants: [...new Set([defaultProfile, ...Object.keys(declared)])].filter((name) => {
      const role = profiles[name];
      return role !== undefined && rank[role.access] >= rank.write;
    }),
  };
}

/** Validate launch rules and reject misspelled names before effects. @internal */
export function validateProfileOverrides(
  value: unknown,
  manifest: CapabilityManifest,
): ProfileOverride[] {
  const rules = z.array(profileOverrideSchema).parse(jsonValue(value));
  for (const rule of rules)
    if (rule.profile !== '*' && !Object.hasOwn(manifest.profiles, rule.profile))
      throw new Error(`Unknown override profile: ${rule.profile}.`);
  return rules as ProfileOverride[];
}

/** Parse a single CLI name.limit=value rule; no semantic overrides. @internal */
export function parseProfileOverride(value: string): ProfileOverride {
  const match =
    /^(\*|[a-zA-Z][a-zA-Z0-9_-]{0,63})\.(timeoutMs|maxTurns|maxBudgetUsd)=((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$/u.exec(
      value,
    );
  if (!match?.[1] || !match[2] || !match[3])
    throw new Error(
      'Invalid --profile; use name.maxTurns=50, name.maxBudgetUsd=3, or *.timeoutMs=1800000.',
    );
  return profileOverrideSchema.parse({
    profile: match[1],
    [match[2]]: Number(match[3]),
  }) as ProfileOverride;
}

/** Pin named grants to exact capabilities across source acceptance/resume. @internal */
export function profileGrantDigest(profile: ResolvedProfile): string {
  return digest({
    tools: profile.claude.tools,
    allowedTools: profile.claude.allowedTools,
    sandbox: profile.codex.sandbox,
  });
}

/** Check a profile/provider capability against persisted operator grants. @internal */
export function requireGrant(
  profile: ResolvedProfile,
  grants: readonly string[],
  pins: Readonly<Record<string, string>>,
  access = profile.access,
): void {
  if (
    rank[access] < rank.write ||
    grants.includes('all') ||
    grants.includes('exec') ||
    (access === 'write' && grants.includes('write')) ||
    (grants.includes(profile.name) && pins[profile.name] === profileGrantDigest(profile))
  )
    return;
  throw new Error(
    `Profile ${profile.name} requires ${access} access. Retry with --grant ${profile.name}, --grant ${access}, or --grant all.`,
  );
}

/** Resolve a call's role and semantics; raw capability calls still need class grants. @internal */
export function resolveProfileCall(
  manifest: CapabilityManifest,
  provider: 'claude' | 'codex',
  call: ClaudeOptions | CodexOptions,
  grants: readonly string[],
  pins: Readonly<Record<string, string>>,
): { profile: ResolvedProfile; options: ClaudeOptions | CodexOptions } {
  const name = call.profile ?? manifest.defaultProfile;
  const profile = manifest.profiles[name];
  if (!Object.hasOwn(manifest.profiles, name) || !profile)
    throw new Error(`Unknown profile: ${name}.`);
  const raw = ['tools', 'allowedTools', 'sandbox'].filter((key) => Object.hasOwn(call, key));
  if (manifest.strictProfiles && raw.length)
    throw new Error(`strictProfiles forbids call-site ${raw.join(', ')}; declare a named profile.`);
  const overrides = { ...call };
  delete overrides.profile;
  const resolved = { ...profile[provider], ...overrides };
  if (provider === 'claude') {
    const claude = resolved as ClaudeOptions;
    const tools = claude.tools ?? [];
    const allowedTools =
      'tools' in call && !('allowedTools' in call) ? tools : (claude.allowedTools ?? tools);
    checkAllowedTools(tools, allowedTools);
    Object.assign(resolved, { allowedTools });
    const access = toolAccess(tools);
    requireGrant(
      profile,
      raw.length ? grants.filter((grant) => !Object.hasOwn(manifest.profiles, grant)) : grants,
      pins,
      access,
    );
  } else {
    requireGrant(
      profile,
      raw.length ? grants.filter((grant) => !Object.hasOwn(manifest.profiles, grant)) : grants,
      pins,
      (resolved as CodexOptions).sandbox === 'workspace-write' ? 'write' : 'read',
    );
  }
  return { profile, options: resolved };
}

const resolvedProfileSchema = z.strictObject({
  ...fields,
  name: nameSchema,
  access: z.enum(['none', 'read', 'write', 'exec']),
  claudeAccess: z.enum(['none', 'read', 'write', 'exec']),
  codexAccess: z.enum(['read', 'write']),
  claude: fields.claude
    .unwrap()
    .extend({ tools: z.array(z.string()), allowedTools: z.array(z.string()) }),
  codex: fields.codex.unwrap().extend({ sandbox: z.enum(['read-only', 'workspace-write']) }),
});
/** Validate persisted manifests as plain declaration data, never executable authority. @internal */
export const capabilityManifestSchema = z.strictObject({
  strictProfiles: z.boolean(),
  defaultProfile: nameSchema,
  defaults: resolvedProfileSchema,
  profiles: z.record(nameSchema, resolvedProfileSchema),
  requiredGrants: z.array(nameSchema),
});
