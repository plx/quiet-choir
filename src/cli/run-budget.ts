import { Flags } from '@oclif/core';
import { runBudgetSchema, type RunBudgetPolicy } from '../workflow/runtime/run-budget.js';

/** Shared execute/resume flags; values remain plain policy in execution plans. @internal */
export const runBudgetFlags = {
  'max-run-cost-usd': Flags.string({
    description: 'Sticky reported-cost gate for new agent attempts; nonnegative USD or off',
  }),
  'max-run-agent-attempts': Flags.string({
    description: 'Sticky total agent-attempt cap across resumes; nonnegative integer or off',
  }),
};

/** Parse explicit removals without treating omission as an unlimited override. @internal */
export function parseRunBudget(cost?: string, attempts?: string): Partial<RunBudgetPolicy> {
  const parse = (value: string, name: string): number | null => {
    if (value === 'off') return null;
    if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(value))
      throw new Error(`${name} must be a nonnegative number or off.`);
    return Number(value);
  };
  const parsed = runBudgetSchema.partial().parse({
    ...(cost === undefined ? {} : { maxRunCostUsd: parse(cost, '--max-run-cost-usd') }),
    ...(attempts === undefined
      ? {}
      : { maxRunAgentAttempts: parse(attempts, '--max-run-agent-attempts') }),
  });
  return {
    ...(parsed.maxRunCostUsd === undefined ? {} : { maxRunCostUsd: parsed.maxRunCostUsd }),
    ...(parsed.maxRunAgentAttempts === undefined
      ? {}
      : { maxRunAgentAttempts: parsed.maxRunAgentAttempts }),
  };
}
