import type { BuiltInHarnesses } from '../../workflow/runtime/harness-model.js';
import type { z } from 'zod';
import { defineHarness } from '../definition.js';
import type { ClaudeOptions } from './claude-options.js';
import type { CodexOptions } from './codex-options.js';
import { claudeOptionsSchema, codexOptionsSchema } from '../../workflow/runtime/options.js';
import { toolAccess } from '../../workflow/runtime/profiles.js';

/** Pure Claude contract; execution adapters are supplied outside the workflow core. */
export const claudeDefinition: BuiltInHarnesses['claude'] = defineHarness({
  name: 'claude',
  revision: 1,
  options: claudeOptionsSchema as z.ZodType<ClaudeOptions>,
  capabilities: { structuredOutput: 'native', sandbox: false, sessionResume: false },
  policy: ['timeoutMs', 'maxTurns', 'maxBudgetUsd', 'retry'],
  capabilityKeys: [
    'tools',
    'allowedTools',
    'disallowedTools',
    'plugins',
    'mcpServers',
    'settings',
    'agents',
    'extraArgs',
    'env',
    'isolation',
  ],
  access: (options) => toolAccess(options.tools ?? []),
});

/** Pure Codex contract; adapter-native defaults never enter the registration schema. */
export const codexDefinition: BuiltInHarnesses['codex'] = defineHarness({
  name: 'codex',
  revision: 1,
  options: codexOptionsSchema as z.ZodType<CodexOptions>,
  capabilities: { structuredOutput: 'native', sandbox: true, sessionResume: false },
  policy: ['timeoutMs', 'retry'],
  capabilityKeys: [
    'sandbox',
    'networkAccess',
    'config',
    'harnessProfile',
    'extraArgs',
    'env',
    'isolation',
  ],
  access: (options) => (options.sandbox === 'workspace-write' ? 'write' : 'read'),
});
