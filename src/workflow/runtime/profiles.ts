import type { HarnessDeclaration } from './harness-model.js';
import { commonControlFields, claudeControlFields, codexControlFields } from './agent-controls.js';
import { validateAgentOptions } from './options.js';
import { GrantRequiredError } from './configuration-error.js';
import { z } from 'zod';
import type { AgentOptions, ClaudeOptions, CodexOptions, JsonValue } from './model.js';
import type {
  AccessClass,
  AgentDefaults,
  AgentProfile,
  CapabilityManifest,
  ProfileOverride,
  RedactedControl,
  ResolvedProfile,
} from './profiles-model.js';
import { digest, jsonValue } from './json.js';
import { harnessIsolationSchema, isolationParts, resolveIsolation } from './agent-isolation.js';
import { environmentSummary, environmentSummarySchema } from './agent-environment.js';
import { builtinCapabilityKeys } from '../../harnesses/builtins/capability-keys.js';
import { codexBlock, legacyEffort, rejectRenamedEffort } from './effort-compat.js';

const nameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
const limits = {
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  idleTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
  maxTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxBudgetUsd: z.number().positive().optional(),
};
// Profiles select configuration mode only; checkout placement (worktree) is a per-call decision.
const profileControlFields = {
  ...commonControlFields,
  isolation: harnessIsolationSchema.optional(),
  worktree: z.never().optional(),
};
const fields = {
  harnesses: z
    .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), z.record(z.string(), z.json()))
    .optional(),
  isolation: harnessIsolationSchema.optional(),
  ...limits,
  description: z.string().optional(),
  access: z.enum(['none', 'read', 'write', 'exec']).optional(),
  expectsToolUse: z.boolean().optional(),
  onPermissionDenied: z.enum(['warn', 'fail']).optional(),
  claude: z
    .strictObject({
      ...profileControlFields,
      ...claudeControlFields,
      model: z.string().min(1).optional(),
      tools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_*.-]*$/u)).optional(),
      allowedTools: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  codex: z
    .strictObject({
      ...profileControlFields,
      ...codexControlFields,
      images: z.never().optional(),
      model: z.string().min(1).optional(),
      sandbox: z.enum(['read-only', 'workspace-write']).optional(),
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
      rule.idleTimeoutMs !== undefined ||
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

/**
 * Check that every `allowedTools` rule selects an exposed tool or narrows a bare exposed tool to a
 * rule such as `Bash(git status)`. Throws on the first rule that would widen access.
 */
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
  const shared = layer.isolation === undefined ? {} : { isolation: layer.isolation };
  const claude = { ...base.claude, ...shared, ...isolationParts(layer.claude ?? {}) };
  // An explicit new exposure list invalidates inherited permissions; infer from the new list.
  if (layer.claude?.tools !== undefined && layer.claude.allowedTools === undefined)
    delete claude.allowedTools;
  return {
    ...base,
    ...layer,
    ...(base.harnesses || layer.harnesses
      ? {
          harnesses: Object.fromEntries(
            [
              ...new Set([
                ...Object.keys(base.harnesses ?? {}),
                ...Object.keys(layer.harnesses ?? {}),
              ]),
            ].map((name) => [name, { ...base.harnesses?.[name], ...layer.harnesses?.[name] }]),
          ),
        }
      : {}),
    claude,
    codex: { ...base.codex, ...shared, ...isolationParts(layer.codex ?? {}) },
  };
}

/** Resolve live capabilities, retaining private environment values only for execution. @internal */
export function resolveCapabilities(definition: {
  readonly defaults?: AgentDefaults;
  readonly profiles?: Readonly<Record<string, AgentProfile>>;
  readonly strictProfiles?: boolean;
  readonly harnesses?: readonly HarnessDeclaration[];
}): CapabilityManifest {
  rejectRenamedEffort('defaults.codex', codexBlock(definition.defaults));
  for (const [name, profile] of Object.entries(definition.profiles ?? {}))
    rejectRenamedEffort(`Profile ${name} codex`, codexBlock(profile));
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
  const registrations = new Map((definition.harnesses ?? []).map((item) => [item.name, item]));
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
    data.claude = resolveIsolation(data.claude ?? {});
    data.codex = resolveIsolation(data.codex ?? {});
    const tools = data.claude.tools ?? [];
    const allowedTools = data.claude.allowedTools ?? tools;
    checkAllowedTools(tools, allowedTools);
    const claudeAccess = controlAccess('claude', { ...data.claude, tools });
    const sandbox = data.codex.sandbox ?? 'read-only';
    const codexAccess = controlAccess('codex', { ...data.codex, sandbox });
    validateAgentOptions('claude', { ...data.claude, tools, allowedTools, prompt: '' });
    validateAgentOptions('codex', { ...data.codex, sandbox, prompt: '' });
    let access = rank[claudeAccess] > rank[codexAccess] ? claudeAccess : codexAccess;
    for (const registered of Object.keys(data.harnesses ?? {}))
      if (!registrations.has(registered))
        throw new Error(`Profile ${name} configures undeclared harness ${registered}.`);
    const harnesses: Record<string, Record<string, JsonValue>> = {};
    const harnessAccess: Record<string, AccessClass> = {};
    const harnessCapabilities: Record<string, Record<string, JsonValue>> = {};
    for (const [registered, declaration] of registrations) {
      const supplied = data.harnesses?.[registered] ?? {};
      for (const field of [
        'prompt',
        'profile',
        'cwd',
        'onError',
        'retry',
        'worktree',
        'timeoutMs',
        'idleTimeoutMs',
        'maxTurns',
        'maxBudgetUsd',
      ])
        if (Object.hasOwn(supplied, field))
          throw new Error(
            `Profile ${name} cannot set harness ${registered}.${field}; use profile limits or call options.`,
          );
      if (!(declaration.options instanceof z.ZodObject))
        throw new Error(`Harness ${registered} options must be a Zod object schema.`);
      harnesses[registered] = partialOptions(declaration.options).parse(supplied) as Record<
        string,
        JsonValue
      >;
      const contract = registeredCapabilities(declaration, {
        ...harnesses[registered],
        prompt: '',
      });
      harnessAccess[registered] = contract.access;
      harnessCapabilities[registered] = contract.controls;
      if (rank[contract.access] > rank[access]) access = contract.access;
    }
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
      ...(registrations.size ? { harnesses, harnessAccess, harnessCapabilities } : {}),
      // The text baseline (no Claude tools, Codex read-only) answers from the prompt; Codex
      // read-only still has a shell, so plain access would make every text call expect tools.
      expectsToolUse: data.expectsToolUse ?? (claudeAccess !== 'none' || codexAccess !== 'read'),
      onPermissionDenied: data.onPermissionDenied ?? 'warn',
      environment: {
        claude: environmentSummary(data.claude.env),
        codex: environmentSummary(data.codex.env),
      },
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

/** Validate capability declarations and expose the public manifest: environment, settings, MCP servers, subagents, system prompts and Codex config appear as names and digests only. */
export function capabilityManifest(definition: {
  readonly defaults?: AgentDefaults;
  readonly profiles?: Readonly<Record<string, AgentProfile>>;
  readonly strictProfiles?: boolean;
  readonly harnesses?: readonly HarnessDeclaration[];
}): CapabilityManifest {
  return publicCapabilityManifest(resolveCapabilities(definition));
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
    /^(\*|[a-zA-Z][a-zA-Z0-9_-]{0,63})\.(timeoutMs|idleTimeoutMs|maxTurns|maxBudgetUsd)=((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$/u.exec(
      value,
    );
  if (!match?.[1] || !match[2] || !match[3])
    throw new Error(
      'Invalid --profile; use name.maxTurns=50, name.maxBudgetUsd=3, *.timeoutMs=1800000, or name.idleTimeoutMs=120000.',
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
    ...capabilityExtras(profile.claude, profile.codex),
    ...(profile.harnessCapabilities
      ? { harnessCapabilities: profile.harnessCapabilities, harnessAccess: profile.harnessAccess }
      : {}),
  });
}

/** Check a profile/harness capability against persisted operator grants. @internal */
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
  throw new GrantRequiredError(profile.name, access);
}

/** Resolve a call's role and semantics; raw capability calls still need class grants. @internal */
export function resolveProfileCall(
  manifest: CapabilityManifest,
  harness: string,
  call: AgentOptions,
  grants: readonly string[],
  pins: Readonly<Record<string, string>>,
  definition?: HarnessDeclaration,
): { profile: ResolvedProfile; options: ClaudeOptions | CodexOptions } {
  const name = call.profile ?? manifest.defaultProfile;
  const profile = manifest.profiles[name];
  if (!Object.hasOwn(manifest.profiles, name) || !profile)
    throw new Error(`Unknown profile: ${name}.`);
  if (harness !== 'claude' && harness !== 'codex') {
    if (!definition) throw new Error(`Missing harness definition ${harness}.`);
    const raw = (definition.capabilityKeys ?? []).filter((key) => Object.hasOwn(call, key));
    if (manifest.strictProfiles && raw.length)
      throw new Error(
        `strictProfiles forbids call-site ${raw.join(', ')} for harness ${harness}; declare a named profile.`,
      );
    const merged = { ...profile.harnesses?.[harness], ...call };
    // Profile selection is runtime-only unless the adapter schema explicitly accepts it.
    Reflect.deleteProperty(merged, 'profile');
    const options = definition.options.parse(merged);
    const { access } = registeredCapabilities(definition, options);
    requireGrant(
      profile,
      raw.length ? grants.filter((grant) => !Object.hasOwn(manifest.profiles, grant)) : grants,
      pins,
      access,
    );
    return { profile, options };
  }
  const raw = builtinCapabilityKeys[harness].filter(
    (key) => Object.hasOwn(call, key) && (key !== 'isolation' || call.isolation === 'inherit'),
  );
  if (manifest.strictProfiles && raw.length)
    throw new Error(`strictProfiles forbids call-site ${raw.join(', ')}; declare a named profile.`);
  const overrides = isolationParts(call);
  Reflect.deleteProperty(overrides, 'profile');
  const resolved = { ...profile[harness], ...overrides };
  if (harness === 'claude') {
    const claude = resolved as ClaudeOptions;
    const tools = claude.tools ?? [];
    const allowedTools =
      'tools' in call && !('allowedTools' in call) ? tools : (claude.allowedTools ?? tools);
    checkAllowedTools(tools, allowedTools);
    Object.assign(resolved, { allowedTools });
    const access = controlAccess('claude', { ...claude, tools });
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
      controlAccess('codex', resolved),
    );
  }
  validateAgentOptions(harness, resolved);
  return { profile, options: resolved };
}

const redactedControlSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  keys: z.array(z.string()).optional(),
});
const resolvedProfileSchema = z.strictObject({
  ...fields,
  harnessAccess: z.record(z.string(), z.enum(['none', 'read', 'write', 'exec'])).optional(),
  harnessCapabilities: z.record(z.string(), z.record(z.string(), z.json())).optional(),
  name: nameSchema,
  environment: z
    .object({ claude: environmentSummarySchema, codex: environmentSummarySchema })
    .optional(),
  redacted: z
    .strictObject({
      claude: z
        .strictObject({
          settings: redactedControlSchema.optional(),
          mcpServers: redactedControlSchema.optional(),
          agents: redactedControlSchema.optional(),
          systemPrompt: redactedControlSchema.optional(),
          appendSystemPrompt: redactedControlSchema.optional(),
        })
        .optional(),
      codex: z.strictObject({ config: redactedControlSchema.optional() }).optional(),
    })
    .optional(),
  access: z.enum(['none', 'read', 'write', 'exec']),
  claudeAccess: z.enum(['none', 'read', 'write', 'exec']),
  codexAccess: z.enum(['read', 'write', 'exec']),
  claude: fields.claude
    .unwrap()
    .extend({ tools: z.array(z.string()), allowedTools: z.array(z.string()) }),
  // Manifests written before #341 spell Codex effort reasoningEffort; authoring stays strict.
  codex: z.preprocess(
    legacyEffort,
    fields.codex.unwrap().extend({ sandbox: z.enum(['read-only', 'workspace-write']) }),
  ),
});
/** Validate persisted manifests as plain declaration data, never executable authority. @internal */
export const capabilityManifestSchema = z.strictObject({
  strictProfiles: z.boolean(),
  defaultProfile: nameSchema,
  defaults: resolvedProfileSchema,
  profiles: z.record(nameSchema, resolvedProfileSchema),
  requiredGrants: z.array(nameSchema),
});

const redactedClaudeControls = [
  'settings',
  'mcpServers',
  'agents',
  'systemPrompt',
  'appendSystemPrompt',
] as const;
const redactedCodexControls = ['config'] as const;

/** Move raw free-form controls out of one harness's options into names and digests. */
function redactControls(
  controls: Record<string, unknown>,
  fields: readonly string[],
): Record<string, RedactedControl> {
  const redacted: Record<string, RedactedControl> = {};
  for (const field of fields) {
    if (!Object.hasOwn(controls, field)) continue;
    const value = controls[field];
    Reflect.deleteProperty(controls, field);
    if (value === undefined) continue;
    redacted[field] =
      typeof value === 'object' && value !== null
        ? { sha256: digest(value), keys: Object.keys(value).sort() }
        : { sha256: digest(value) };
  }
  return redacted;
}

/**
 * Snapshot for checkpoints and CLI diagnostics; live execution retains its private values. Drops
 * environment values (names and a digest stay in `environment`) and moves Claude settings, MCP
 * servers, subagents, system prompts and Codex config into `redacted` as digests with top-level
 * names. Apply only to a live manifest from resolveCapabilities: a second pass re-digests
 * registered harness env digests. @internal
 */
export function publicCapabilityManifest(manifest: CapabilityManifest): CapabilityManifest {
  const result = structuredClone(manifest);
  for (const profile of [result.defaults, ...Object.values(result.profiles)]) {
    Reflect.deleteProperty(profile.claude, 'env');
    Reflect.deleteProperty(profile.codex, 'env');
    const claude = redactControls(profile.claude, redactedClaudeControls);
    const codex = redactControls(profile.codex, redactedCodexControls);
    if (Object.keys(claude).length > 0 || Object.keys(codex).length > 0)
      Object.assign(profile, {
        redacted: {
          ...profile.redacted,
          ...(Object.keys(claude).length > 0
            ? { claude: { ...profile.redacted?.claude, ...claude } }
            : {}),
          ...(Object.keys(codex).length > 0
            ? { codex: { ...profile.redacted?.codex, ...codex } }
            : {}),
        },
      });
    for (const controls of Object.values(profile.harnesses ?? {}))
      Reflect.deleteProperty(controls, 'env');
    for (const controls of Object.values(profile.harnessCapabilities ?? {}))
      if (Object.hasOwn(controls, 'env'))
        Object.assign(controls, { env: { sha256: digest(controls['env']) } });
  }
  return result;
}

function capabilityExtras(
  claude: NonNullable<AgentProfile['claude']>,
  codex: NonNullable<AgentProfile['codex']>,
): Record<string, unknown> {
  const extras = Object.fromEntries(
    (
      [
        ['claude', claude],
        ['codex', codex],
      ] as const
    ).flatMap(([harness, controls]) =>
      Object.entries(controls)
        .filter(
          ([key]) =>
            builtinCapabilityKeys[harness].some((field) => field === key) &&
            !['tools', 'allowedTools', 'sandbox'].includes(key),
        )
        .map(([key, value]) => [`${harness}.${key}`, value]),
    ),
  );
  return extras;
}
/** Classify configuration/escape hatches conservatively without interpreting native plugins. @internal */
export function controlAccess(
  harness: 'claude' | 'codex',
  // Effort never affects access, and the two harnesses accept different effort levels.
  value: Partial<Omit<ClaudeOptions & CodexOptions, 'effort'>>,
): AccessClass {
  if (
    value.isolation === 'inherit' ||
    (value.plugins?.length ?? 0) > 0 ||
    value.agent !== undefined ||
    value.agents !== undefined ||
    value.mcpServers !== undefined ||
    value.settings !== undefined ||
    value.harnessProfile !== undefined ||
    value.config !== undefined ||
    (value.extraArgs?.length ?? 0) > 0 ||
    value.env !== undefined ||
    value.networkAccess === true
  )
    return 'exec';
  if (harness === 'codex')
    return value.sandbox === 'workspace-write' || (value.addDirs?.length ?? 0) > 0
      ? 'write'
      : 'read';
  const tools = toolAccess(value.tools ?? []);
  if (tools === 'none' && (value.addDirs?.length ?? 0) > 0) return 'read';
  return tools;
}

/** Field-wise partial view; object-level refinements apply only to a complete merged call. */
function partialOptions(options: z.ZodObject): z.ZodObject {
  return z.strictObject(options.shape).partial();
}

/** Conservatively classify package-defined capabilities, without applying adapter defaults. @internal */
export function registeredCapabilities(
  definition: HarnessDeclaration,
  options: unknown,
): { access: AccessClass; controls: Record<string, JsonValue> } {
  const parsed =
    definition.options instanceof z.ZodObject
      ? partialOptions(definition.options).safeParse(options)
      : definition.options.safeParse(options);
  const access =
    parsed.success && definition.access ? definition.access(parsed.data as never) : 'exec';
  if (!Object.hasOwn(rank, access))
    throw new Error(`Harness ${definition.name} returned an invalid access class.`);
  const value = options as Record<string, unknown>;
  const controls = Object.fromEntries(
    (definition.capabilityKeys ?? [])
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, jsonValue(value[key])]),
  );
  return { access, controls };
}
