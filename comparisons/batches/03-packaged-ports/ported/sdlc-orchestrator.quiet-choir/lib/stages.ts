// Stage mechanics: command verdicts, the delegation maps for --require-grants, the review
// question's preview and the final status rule.
import type { ExecResult, ExecStepError, Settled } from 'quiet-choir';
import type { Stage, StageRecord } from '../contracts.js';

/** A settled failure has no truncation flag, so its kind, exit code and signal stand in for it. */
export const commandDetails = (result: Settled<ExecResult, ExecStepError>): string =>
  result.ok
    ? `exit=${result.value.code}; truncated=${result.value.truncated}`
    : `failure=${result.error.kind}; exit=${result.error.code ?? null}; signal=${result.error.signal ?? null}`;

/** Each child's roster entries onto the orchestrator's Reader and Writer ceilings. */
export const delegation = {
  document: { Author: 'Reader', Reviewer: 'Reader' },
  implementation: { Implementer: 'Writer' },
  bootstrap: { Surveyor: 'Reader', Planner: 'Reader', Setter: 'Writer' },
  releaseNotes: { Summarizer: 'Reader', Drafter: 'Reader', FactChecker: 'Reader' },
} as const;

/** A bounded preview for the stage review question; the subject carries the whole result. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');

/** Complete only when every planned stage's latest result passed and nothing was skipped. */
export const finalStatus = (plan: Stage[], stages: StageRecord[], skipped: Stage[]) =>
  plan.some((stage) => stages.findLast((entry) => entry.stage === stage)?.result.gate !== 'pass') ||
  skipped.length
    ? ('needs-review' as const)
    : ('complete' as const);
