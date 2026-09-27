import type { AgentUsage, JsonValue } from '../workflow/runtime/model.js';
import type { ModelUsage, TokenCounts } from '../workflow/runtime/usage-model.js';
import { knownSum, measurement, normalizeUsage, usageObject } from '../workflow/runtime/usage.js';

/** Claude's top-level usage is not a session total; use modelUsage for token totals. @internal */
export function claudeUsage(data: Record<string, unknown>, requested: string | null): AgentUsage {
  const models = usageObject(data['modelUsage']);
  const entries = Object.entries(models ?? {});
  const byModel: Record<string, ModelUsage> = Object.fromEntries(
    entries.map(([name, raw]) => {
      const value = usageObject(raw);
      return [
        name,
        {
          uncachedInput: measurement(value?.['inputTokens']),
          cacheRead: measurement(value?.['cacheReadInputTokens']),
          cacheWrite: measurement(value?.['cacheCreationInputTokens']),
          output: measurement(value?.['outputTokens']),
          reasoning: measurement(value?.['thinkingTokens']),
          costUsd: measurement(value?.['costUSD']),
        },
      ];
    }),
  );
  const all = Object.values(byModel);
  const sum = (key: keyof TokenCounts): number | null => knownSum(all.map((value) => value[key]));
  const tokens: TokenCounts = {
    uncachedInput: sum('uncachedInput'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    output: sum('output'),
    reasoning: sum('reasoning'),
  };
  const costUsd = measurement(data['total_cost_usd']);
  return normalizeUsage({
    inputTokens: knownSum([tokens.uncachedInput, tokens.cacheRead, tokens.cacheWrite]),
    outputTokens: tokens.output,
    costUsd,
    tokens,
    byModel,
    model: { requested, effective: entries.length ? entries.map(([name]) => name) : null },
    reported: {
      usage: (data['usage'] ?? null) as JsonValue,
      modelUsage: (data['modelUsage'] ?? null) as JsonValue,
      total_cost_usd: (data['total_cost_usd'] ?? null) as JsonValue,
    },
  });
}

/** Codex passes through Responses totals; preserve cache-write evidence without guessing a partition. @internal */
export function codexUsage(raw: unknown, requested: string | null): AgentUsage {
  const value = usageObject(raw);
  const inputTokens = measurement(value?.['input_tokens']);
  const outputTokens = measurement(value?.['output_tokens']);
  return normalizeUsage({
    inputTokens,
    outputTokens,
    costUsd: null,
    tokens: {
      uncachedInput: null,
      cacheRead: measurement(value?.['cached_input_tokens']),
      cacheWrite: measurement(value?.['cache_write_input_tokens']),
      output: outputTokens,
      reasoning: measurement(value?.['reasoning_output_tokens']),
    },
    model: { requested, effective: null },
    reported: (raw ?? null) as JsonValue,
  });
}
