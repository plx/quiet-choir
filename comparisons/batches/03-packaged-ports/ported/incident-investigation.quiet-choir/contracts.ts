// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);

export const Domain = z.enum(['diffs', 'logs', 'config', 'deps']);
export type Domain = z.infer<typeof Domain>;
export const Fact = z.object({
  fact: z.string().min(1).describe('One observable fact, without interpretation'),
  source: z.string().min(1).describe('A SHA, file, log line or config path'),
  timestamp: z.string().min(1).describe('When it occurred or changed; "unknown" is allowed'),
  oddity: z.boolean().describe('Surprising on its own terms, regardless of any hypothesis'),
});
export const Facts = z.object({ facts: z.array(Fact).max(40) });
export const Evidence = Fact.extend({ domain: Domain });
export type Evidence = z.infer<typeof Evidence>;

export const Hypothesis = z.object({
  id: z.string().min(1).max(8),
  story: z.string().min(1).describe('The causal chain from trigger to symptom'),
  mechanism: z.string().min(1),
  predictions: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .describe('Checkable facts that must hold if the hypothesis is true'),
  priorPlausibility: z.enum(['high', 'medium', 'low']),
});
export type Hypothesis = z.infer<typeof Hypothesis>;
export const Hypotheses = z.object({ hypotheses: z.array(Hypothesis).min(1).max(5) });

export const Verdict = z.object({
  verdict: z.enum(['falsified', 'survives', 'untestable']),
  reasoning: z.string().min(1),
  checkedPredictions: z.array(
    z.object({ prediction: z.string(), held: z.boolean(), evidence: z.string() }),
  ),
});
/** A hypothesis with its falsifier's verdict, or null when the falsifier failed. */
export const Judged = Hypothesis.extend({ verdict: Verdict.nullable() });
export type Judged = z.infer<typeof Judged>;
export const Confidence = z.enum(['high', 'medium', 'split', 'none']);
export type Confidence = z.infer<typeof Confidence>;

export const IncidentInput = z.object({
  incident: z.string().min(1).describe('Observed symptoms, impact and incident timeline'),
  since: z.string().min(1).describe('Exclusive starting Git revision for the investigation'),
  until: z.string().min(1).default('HEAD'),
  artifacts: z.array(z.string().min(1)).max(20).default([]),
  domains: z
    .array(Domain)
    .min(1)
    .max(4)
    .default(['diffs', 'logs', 'config', 'deps'])
    .describe('Evidence collectors to run, each without a hypothesis'),
});

export const IncidentOutput = z.object({
  start: Sha,
  end: Sha,
  manifest: z.array(Sha),
  clean: z.literal(true),
  evidence: z.array(Evidence),
  uncollected: z.array(Domain),
  hypotheses: z.array(Judged),
  confidence: Confidence,
  rootCause: z.string().nullable(),
  report: z.string(),
});
