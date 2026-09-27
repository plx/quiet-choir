import { z } from 'zod';
import type {
  AgentUsage,
  Harness,
  HarnessInvocation,
  HarnessRequest,
  HarnessResponse,
  JsonValue,
} from '../workflow/runtime/model.js';
import { jsonValue } from '../workflow/runtime/json.js';
import { matchesStepGlob } from '../workflow/runtime/policy.js';
import { synthesizeOutput } from './synthesize.js';

/** One first-match fixture rule; exactly one of output, text, or error must be present. */
export interface FixtureCall {
  /** Step-ID glob: * stays within a segment; ** crosses segments. */
  readonly step: string;
  /** Restrict this rule to one provider. */
  readonly provider?: 'claude' | 'codex';
  /** Restrict this rule to a cumulative one-based attempt. */
  readonly attempt?: number;
  /** Structured output, including null, validated by the workflow's original schema. */
  readonly output?: JsonValue;
  /** Raw response text, parsed normally for structured calls. */
  readonly text?: string;
  /** Simulated invocation failure. */
  readonly error?: string;
  /** Optional measurements; missing values become null. */
  readonly usage?: Partial<AgentUsage>;
}

/** Portable, versioned agent fixtures, exportable from completed run records. */
export interface HarnessFixtures {
  /** Fixture file version. */
  readonly version: 1;
  /** Rules in first-match order. */
  readonly calls: readonly FixtureCall[];
  /** Missing calls fail by default, or receive a deterministic schema sample. */
  readonly unmatched?: 'error' | 'synthesize';
}

const rule = z
  .object({
    step: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9*][a-zA-Z0-9._:/*-]*$/u),
    provider: z.enum(['claude', 'codex']).optional(),
    attempt: z.number().int().positive().optional(),
    output: z.json().optional(),
    text: z.string().optional(),
    error: z.string().min(1).optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().nullable().optional(),
        outputTokens: z.number().nonnegative().nullable().optional(),
        costUsd: z.number().nonnegative().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => ['output', 'text', 'error'].filter((key) => Object.hasOwn(value, key)).length === 1,
    'Exactly one of output, text, or error is required.',
  );

/** Validate untrusted fixture data before importing or executing workflow code. */
export function parseHarnessFixtures(value: unknown): HarnessFixtures {
  return z
    .object({
      version: z.literal(1),
      calls: z.array(rule),
      unmatched: z.enum(['error', 'synthesize']).optional(),
    })
    .strict()
    .parse(jsonValue(value)) as HarnessFixtures;
}

/** Free harness that routes on durable call identity and returns normal adapter responses. */
export class FixtureHarness implements Harness {
  /** Recorded provenance; changing to native execution requires explicit authorization. */
  public readonly kind: string = 'fixture';
  private readonly fixtures: HarnessFixtures;
  /** Copy and validate fixture rules so later caller mutation cannot change routing. */
  public constructor(fixtures: HarnessFixtures) {
    this.fixtures = parseHarnessFixtures(fixtures);
  }
  /** Find the first rule for a named attempt; exposed for rehearsal output-source diagnostics. */
  protected match(
    request: HarnessRequest,
  ): { readonly fixture: FixtureCall; readonly index: number } | undefined {
    const index = this.fixtures.calls.findIndex(
      (entry) =>
        matchesStepGlob(entry.step, request.call.stepId) &&
        (entry.provider === undefined || entry.provider === request.provider) &&
        (entry.attempt === undefined || entry.attempt === request.call.attempt),
    );
    const fixture = this.fixtures.calls[index];
    return fixture === undefined ? undefined : { fixture, index };
  }
  /** Resolve a fixture without subprocesses; the runtime still parses, validates, and checkpoints it. */
  public invoke(request: HarnessRequest, invocation: HarnessInvocation): Promise<HarnessResponse> {
    invocation.signal.throwIfAborted();
    const match = this.match(request);
    const fixture = match?.fixture;
    if (!fixture && this.fixtures.unmatched !== 'synthesize')
      return Promise.reject(
        new Error(
          `No fixture matches step ${request.call.stepId} (${request.provider}, attempt ${String(request.call.attempt)}).`,
        ),
      );
    if (fixture?.error !== undefined)
      return Promise.reject(new Error(`Step ${request.call.stepId}: ${fixture.error}`));
    return Promise.resolve({
      text:
        fixture?.text ??
        (fixture && Object.hasOwn(fixture, 'output')
          ? request.outputSchema === null && typeof fixture.output === 'string'
            ? fixture.output
            : JSON.stringify(fixture.output)
          : request.outputSchema === null
            ? `[dry-run ${request.provider} ${request.call.stepId}]`
            : JSON.stringify(synthesizeOutput(request.outputSchema, request.call.stepId))),
      sessionId: null,
      usage: {
        inputTokens: fixture?.usage?.inputTokens ?? null,
        outputTokens: fixture?.usage?.outputTokens ?? null,
        costUsd: fixture?.usage?.costUsd ?? null,
      },
    });
  }
}
