import {
  defaultAgentLimits,
  validateAgentLimits,
  type AgentLimits,
} from '../runtime/agent-limiter.js';

/** Translate CLI decimal limits into serializable policy before workflow imports. @internal */
export function parseAgentLimits(
  total: string | undefined,
  providers: readonly string[],
): AgentLimits {
  if (total !== undefined && !/^[1-9][0-9]*$/u.test(total))
    throw new Error('--max-agents must be a positive integer.');
  const perProvider = Object.fromEntries(
    providers.map((rule) => {
      const match = /^([a-zA-Z][a-zA-Z0-9_-]*)=([1-9][0-9]*)$/u.exec(rule);
      if (!match?.[1] || !match[2])
        throw new Error('--provider-limit must be provider=<positive integer>, e.g. claude=2.');
      return [match[1], Number(match[2])];
    }),
  );
  return validateAgentLimits({
    total: total === undefined ? defaultAgentLimits().total : Number(total),
    ...(providers.length ? { perProvider } : {}),
  });
}
