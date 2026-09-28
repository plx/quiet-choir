import { z } from 'zod';
import type { JsonValue } from './model.js';

/** Shared validated effort levels. @internal */
export const effortValues = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Codex's additional provider-specific levels. @internal */
export const codexEffortValues = ['none', 'minimal', ...effortValues] as const;
/** Deliberately excludes interactive and bypass modes. @internal */
export const permissionModeValues = ['dontAsk', 'acceptEdits', 'plan'] as const;
const strings = z.array(z.string().min(1));
const data = z.record(z.string(), z.json());
/** Shared optional controls, reused by call and profile validators. @internal */
export const commonControlFields = {
  effort: z.enum(effortValues).optional(),
  addDirs: strings.optional(),
  extraArgs: strings.optional(),
  env: z
    .record(
      z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
      z.string().refine((value) => !value.includes('\0')),
    )
    .optional(),
};
/** Claude-only semantic fields. @internal */
export const claudeControlFields = {
  disallowedTools: strings.optional(),
  permissionMode: z.enum(permissionModeValues).optional(),
  systemPrompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  agent: z.string().min(1).optional(),
  agents: z
    .record(
      z.string().min(1),
      z.object({ description: z.string(), prompt: z.string() }).catchall(z.json()),
    )
    .optional(),
  mcpServers: data.optional(),
  strictMcpConfig: z.boolean().optional(),
  settings: data.optional(),
  fallbackModel: z.union([z.string().min(1), strings.min(1)]).optional(),
};
/** Codex-only semantic fields. @internal */
export const codexControlFields = {
  reasoningEffort: z.enum(codexEffortValues).optional(),
  networkAccess: z.boolean().optional(),
  harnessProfile: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
    .optional(),
  config: data.optional(),
  images: strings.optional(),
};

const commonOwners: Record<string, string> = {
  model: 'model',
  effort: 'effort',
  'add-dir': 'addDirs',
};
const owners: Record<'claude' | 'codex', Record<string, string>> = {
  claude: {
    ...commonOwners,
    tools: 'tools',
    allowedTools: 'allowedTools',
    disallowedTools: 'disallowedTools',
    'permission-mode': 'permissionMode',
    'system-prompt': 'systemPrompt',
    'system-prompt-file': 'systemPrompt',
    'append-system-prompt': 'appendSystemPrompt',
    'append-system-prompt-file': 'appendSystemPrompt',
    agent: 'agent',
    agents: 'agents',
    'mcp-config': 'mcpServers',
    'strict-mcp-config': 'strictMcpConfig',
    settings: 'settings',
    'fallback-model': 'fallbackModel',
    'max-turns': 'maxTurns',
    'max-budget-usd': 'maxBudgetUsd',
    print: 'adapter output',
    'output-format': 'adapter output',
    'input-format': 'adapter input',
    'json-schema': 'schema',
    'no-session-persistence': 'adapter session',
    verbose: 'adapter output',
    'session-id': 'adapter session',
    resume: 'adapter session',
    continue: 'adapter session',
    'fork-session': 'adapter session',
    worktree: 'adapter cwd',
    'dangerously-skip-permissions': 'permissionMode (bypass is unsupported)',
    'allow-dangerously-skip-permissions': 'permissionMode (bypass is unsupported)',
    help: 'adapter execution',
    version: 'adapter execution',
    background: 'adapter session',
    bg: 'adapter session',
    cloud: 'adapter session',
    'remote-control': 'adapter session',
    'from-pr': 'adapter session',
    teleport: 'adapter session',
    'permission-prompts': 'adapter permissions',
    'permission-prompt-tool': 'adapter permissions',
  },
  codex: {
    ...commonOwners,
    profile: 'harnessProfile',
    config: 'config',
    image: 'images',
    sandbox: 'sandbox',
    'skip-git-repo-check': 'skipGitRepoCheck',
    json: 'adapter output',
    'output-schema': 'schema',
    ephemeral: 'adapter session',
    color: 'adapter output',
    cd: 'cwd',
    worktree: 'adapter cwd',
    'output-last-message': 'adapter output',
    'approve-for-me': 'sandbox/approval policy',
    'dangerously-bypass-approvals-and-sandbox': 'sandbox (bypass is unsupported)',
    'dangerously-bypass-hook-trust': 'hook trust (bypass is unsupported)',
    'ask-for-approval': 'adapter approval policy',
    'full-auto': 'adapter approval policy',
    help: 'adapter execution',
    version: 'adapter execution',
  },
};
const aliases: Record<'claude' | 'codex', Record<string, string>> = {
  claude: { p: 'print', r: 'resume', c: 'continue', w: 'worktree', h: 'help', v: 'version' },
  codex: {
    c: 'config',
    p: 'profile',
    i: 'image',
    s: 'sandbox',
    C: 'cd',
    m: 'model',
    o: 'output-last-message',
    a: 'ask-for-approval',
    h: 'help',
    V: 'version',
  },
};
const normalize = (value: string): string => value.replace(/[-_]/gu, '').toLowerCase();
/** Reject protocol/typed-flag shadowing, including aliases, equals forms, and short clusters. @internal */
export function validateExtraArgs(provider: 'claude' | 'codex', args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split('=')[0] ?? '';
    let owner: string | undefined;
    if (flag.startsWith('--')) {
      owner = Object.entries(owners[provider]).find(
        ([name]) => normalize(name) === normalize(flag.slice(2)),
      )?.[1];
      if (normalize(flag).includes('dangerously'))
        owner = 'permission controls (bypass is unsupported)';
    } else if (flag.startsWith('-')) {
      for (const char of flag.slice(1)) {
        const name = aliases[provider][char];
        if (name !== undefined) {
          owner = owners[provider][name];
          break;
        }
      }
    }
    if (owner)
      throw new Error(
        `extraArgs ${JSON.stringify(arg)} is owned by ${owner}; use its typed option.`,
      );
    // Requiring attached values makes positional prompts/subcommands and variadic consumption impossible.
    if (!/^--[a-zA-Z][a-zA-Z0-9-]*(?:=[^\0]*)?$/u.test(arg))
      throw new Error(
        `Invalid extraArgs ${JSON.stringify(arg)}: use --flag or --flag=value; positional arguments, subcommands and short flags are unsupported.`,
      );
  }
}

const reservedConfig: Record<string, string> = {
  approval_policy: 'adapter approval policy',
  sandbox_mode: 'sandbox',
  model: 'model',
  model_reasoning_effort: 'effort/reasoningEffort',
  'sandbox_workspace_write.network_access': 'networkAccess',
  'sandbox_workspace_write.writable_roots': 'addDirs',
  profile: 'harnessProfile',
  profiles: 'harnessProfile',
};
/** TOML literal for explicit JSON values; null has no TOML representation. @internal */
export function tomlLiteral(value: JsonValue): string {
  if (value === null) throw new Error('Codex config cannot contain null.');
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`;
  return `{ ${Object.entries(value)
    .map(([key, child]) => `${JSON.stringify(key)} = ${tomlLiteral(child)}`)
    .join(', ')} }`;
}
/** Restrict config aliases of owned settings, including parent tables and nested keys. @internal */
export function validateConfig(config: Readonly<Record<string, JsonValue>>): void {
  for (const [key, value] of Object.entries(config)) {
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/u.test(key))
      throw new Error(`Invalid Codex config key: ${key}. Use unquoted dotted keys.`);
    const match = Object.entries(reservedConfig).find(
      ([reserved]) =>
        key === reserved || key.startsWith(`${reserved}.`) || reserved.startsWith(`${key}.`),
    );
    if (match)
      throw new Error(`Codex config ${key} is owned by ${match[1]}; use its typed option.`);
    tomlLiteral(value);
  }
}

/** Reject alternate settings routes to typed controls and bypass permission modes. @internal */
export function validateClaudeSettings(settings: Readonly<Record<string, JsonValue>>): void {
  for (const key of [
    'model',
    'effortLevel',
    'modelSettings',
    'agent',
    'agents',
    'mcpServers',
    'permissions',
  ])
    if (Object.hasOwn(settings, key))
      throw new Error(`Claude settings ${key} is owned by typed agent/permission/model options.`);
}
/** Validate nested subagent data while leaving native, non-bypass subagent controls available. @internal */
export function rejectBypass(value: JsonValue): void {
  if (typeof value === 'string' && ['bypassPermissions', 'danger-full-access'].includes(value))
    throw new Error('Bypass permission modes are unsupported.');
  if (Array.isArray(value)) value.forEach(rejectBypass);
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (normalize(key).includes('dangerously'))
        throw new Error('Bypass permission controls are unsupported.');
      rejectBypass(child);
    }
}
