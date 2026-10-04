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
  'max-window-utilization': Flags.string({
    description:
      'Sticky subscription-window utilization gate for new agent attempts, 0 to 1 or off; suspends until the window resets',
  }),
};

const decimal = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu;

/** Parse explicit removals without treating omission as an unlimited override. @internal */
export function parseRunBudget(
  cost?: string,
  attempts?: string,
  windowUtilization?: string,
): Partial<RunBudgetPolicy> {
  const parse = (value: string, name: string): number | null => {
    if (value === 'off') return null;
    if (!decimal.test(value)) throw new Error(`${name} must be a nonnegative number or off.`);
    return Number(value);
  };
  const fraction = (value: string): number | null => {
    if (value === 'off') return null;
    if (!decimal.test(value) || Number(value) > 1)
      throw new Error('--max-window-utilization must be a number from 0 to 1 or off.');
    return Number(value);
  };
  const parsed = runBudgetSchema.partial().parse({
    ...(cost === undefined ? {} : { maxRunCostUsd: parse(cost, '--max-run-cost-usd') }),
    ...(attempts === undefined
      ? {}
      : { maxRunAgentAttempts: parse(attempts, '--max-run-agent-attempts') }),
    ...(windowUtilization === undefined
      ? {}
      : { maxWindowUtilization: fraction(windowUtilization) }),
  });
  return {
    ...(parsed.maxRunCostUsd === undefined ? {} : { maxRunCostUsd: parsed.maxRunCostUsd }),
    ...(parsed.maxRunAgentAttempts === undefined
      ? {}
      : { maxRunAgentAttempts: parsed.maxRunAgentAttempts }),
    ...(parsed.maxWindowUtilization === undefined
      ? {}
      : { maxWindowUtilization: parsed.maxWindowUtilization }),
  };
}
