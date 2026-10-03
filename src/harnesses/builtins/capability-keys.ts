import type { ClaudeOptions } from './claude-options.js';
import type { CodexOptions } from './codex-options.js';

// An import-free leaf (type imports only), so the built-in definitions, the runtime strict check
// and the call-site types read one list without pulling the run store into workflow type checks.
// isolatedDeclarations needs the explicit tuple types; `satisfies` checks each key exists.

/**
 * Claude Code options that strict profiles own: under `strictProfiles` a call site may not set them
 * (for isolation only `'inherit'` is rejected), and named profiles declare them instead.
 */
export const claudeCapabilityKeys: readonly [
  'tools',
  'allowedTools',
  'disallowedTools',
  'permissionMode',
  'agent',
  'agents',
  'plugins',
  'mcpServers',
  'strictMcpConfig',
  'settings',
  'addDirs',
  'extraArgs',
  'env',
  'isolation',
] = [
  'tools',
  'allowedTools',
  'disallowedTools',
  'permissionMode',
  'agent',
  'agents',
  'plugins',
  'mcpServers',
  'strictMcpConfig',
  'settings',
  'addDirs',
  'extraArgs',
  'env',
  'isolation',
] as const satisfies readonly (keyof ClaudeOptions)[];

/**
 * Codex options that strict profiles own: under `strictProfiles` a call site may not set them (for
 * isolation only `'inherit'` is rejected), and named profiles declare them instead.
 */
export const codexCapabilityKeys: readonly [
  'sandbox',
  'networkAccess',
  'config',
  'harnessProfile',
  'addDirs',
  'extraArgs',
  'env',
  'isolation',
] = [
  'sandbox',
  'networkAccess',
  'config',
  'harnessProfile',
  'addDirs',
  'extraArgs',
  'env',
  'isolation',
] as const satisfies readonly (keyof CodexOptions)[];

/** The strict-profile capability keys of each built-in harness. @internal */
export const builtinCapabilityKeys: {
  readonly claude: typeof claudeCapabilityKeys;
  readonly codex: typeof codexCapabilityKeys;
} = { claude: claudeCapabilityKeys, codex: codexCapabilityKeys };
