import { z } from 'zod';
import type {
  AgentUsage,
  ErrorKind,
  Harness,
  HarnessInvocation,
  HarnessRequest,
  HarnessResponse,
  JsonValue,
} from '../harness-kit.js';
import { ConfigurationError, HarnessError } from '../harness-kit.js';
import { jsonValue } from '../harness-kit.js';
import { matchesStepGlob } from '../harness-kit.js';
import { synthesizeOutput } from './synthesize.js';
import { errorKindSchema } from '../workflow/runtime/step-error.js';

/** One first-match fixture rule; exactly one of output, text, or error must be present. */
export interface FixtureCall {
  /** Step-ID glob: * stays within a segment; ** crosses segments. */
  readonly step: string;
  /** Restrict this rule to one harness. */
  readonly harness?: string;
  /** Restrict this rule to a cumulative one-based attempt. */
  readonly attempt?: number;
  /** Structured output, including null, validated by the workflow's original schema. */
  readonly output?: JsonValue;
  /** Raw response text, parsed normally for structured calls. */
  readonly text?: string;
  /** Simulated invocation failure. */
  readonly error?: string;
  /**
   * Failure category for `error`, so `retry.on` and branches on `error.kind` can be rehearsed. The
   * call then rejects with a {@link HarnessError} of this kind; without it the failure is `unknown`.
   * Requires `error`.
   */
  readonly kind?: ErrorKind;
  /** Optional measurements; missing values become null. */
  readonly usage?: Partial<AgentUsage>;
}

/**
 * One first-match command rule for `ctx.exec` and `ctx.exec.json`; exactly one of `json`, `stdout`
 * or `error` must be present. Every filter that is present must hold, whichever kind of rule it is.
 */
export interface FixtureExecCall {
  /** Step-ID glob: * stays within a segment; ** crosses segments. */
  readonly step: string;
  /** Leading argv elements, compared exactly; a rule with a prefix never matches a shell command. */
  readonly argvPrefix?: readonly [string, ...string[]];
  /** SHA-256 of the explicit environment overlay, as recorded in the step's exec summary. */
  readonly envSha256?: string;
  /** SHA-256 of stdin, as recorded in the step's exec summary. */
  readonly inputSha256?: string;
  /** Restrict this rule to a cumulative one-based attempt. */
  readonly attempt?: number;
  /**
   * Restrict this rule to the nth distinct step ID (one-based) that meets its step, argv and digest
   * filters in this process. Retries of one step keep their occurrence. A step ID is the parent's
   * for a command a callback or observer issues through `context.exec`, so all of one parent's
   * commands share an occurrence: use {@link FixtureExecCall.call} to choose among them.
   */
  readonly occurrence?: number;
  /**
   * Restrict this rule to the nth command (one-based) of one parent. For a command a callback or
   * observer issues through `context.exec`, it is the command's position among those that meet
   * this rule's step, argv and digest filters for the same parent ID and attempt, in this process.
   * The count is per rule, so it never depends on the rules before it, and `argvPrefix` makes it
   * count only the matching commands. A retry reruns the callback, so its first command is call 1
   * again; poll observations always run as attempt 1, so a wait's count keeps growing across its
   * checks in one process. A `ctx.exec` effect runs exactly one command per attempt, so its call is
   * always 1: `call: 1` matches it and `call: 2` never does. Steps replayed from a checkpoint are
   * not counted, concurrent commands count in the order they reach the process runner, and a poll
   * that suspends and resumes in a new process starts again at call 1. Combines with `occurrence`
   * (which parent) and `attempt`.
   */
  readonly call?: number;
  /** Structured stdout, serialized as JSON and parsed by the step's own schema. */
  readonly json?: JsonValue;
  /** Raw stdout text. */
  readonly stdout?: string;
  /** Raw stderr text, default empty. */
  readonly stderr?: string;
  /** Exit code, default 0; checked against the step's `okExitCodes` like a real exit. */
  readonly code?: number;
  /**
   * Simulated command failure, such as a missing binary or a timeout: the command rejects with an
   * `ExecError` whose message is this text verbatim (no step prefix), immediately, as a real
   * spawn failure does. The error carries no process result, so its diagnostics have a null exit
   * code and signal, empty output tails and zero duration; a real timeout's signal and partial
   * output are not reproduced. `stderr` and `code` do not apply to an error rule.
   */
  readonly error?: string;
  /**
   * Failure category for `error`, so `retry.on` and branches on `error.kind` can be rehearsed. The
   * default is `process`, the kind the real runner gives every failure it cannot classify more
   * precisely (unlike an agent rule, whose default is `unknown`). Requires `error`.
   */
  readonly kind?: ErrorKind;
}

/** Portable, versioned agent fixtures, exportable from completed run records. */
export interface HarnessFixtures {
  /** Fixture file version. */
  readonly version: 1;
  /** Rules in first-match order. */
  readonly calls: readonly FixtureCall[];
  /** Missing calls fail by default, or receive a deterministic schema sample. */
  readonly unmatched?: 'error' | 'synthesize';
  /** Command rules in first-match order, for `ctx.exec` effects. */
  readonly exec?: readonly FixtureExecCall[];
  /**
   * `fixture` fails a command that no exec rule matches, at its step, instead of synthesizing it
   * (under `--dry-run`) or running it (under `--harness fixture`).
   */
  readonly commands?: 'fixture';
}

const stepGlob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9*][a-zA-Z0-9._:/*-]*$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const rule = z
  .object({
    step: stepGlob,
    harness: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/u)
      .optional(),
    provider: z.enum(['claude', 'codex']).optional(),
    attempt: z.number().int().positive().optional(),
    output: z.json().optional(),
    text: z.string().optional(),
    error: z.string().min(1).optional(),
    kind: errorKindSchema.optional(),
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
    (value) =>
      value.harness === undefined ||
      value.provider === undefined ||
      value.harness === value.provider,
    'Conflicting harness and legacy provider names.',
  )
  .transform(({ provider, ...value }) => ({
    ...value,
    ...(value.harness === undefined && provider !== undefined ? { harness: provider } : {}),
  }))
  .refine(
    (value) => ['output', 'text', 'error'].filter((key) => Object.hasOwn(value, key)).length === 1,
    'Exactly one of output, text, or error is required.',
  )
  .refine((value) => value.kind === undefined || value.error !== undefined, 'kind requires error.');

const execRule = z
  .object({
    step: stepGlob,
    argvPrefix: z.tuple([z.string()], z.string()).optional(),
    envSha256: sha256.optional(),
    inputSha256: sha256.optional(),
    attempt: z.number().int().positive().optional(),
    occurrence: z.number().int().positive().optional(),
    call: z.number().int().positive().optional(),
    json: z.json().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    code: z.number().int().min(0).max(255).optional(),
    error: z.string().min(1).optional(),
    kind: errorKindSchema.optional(),
  })
  .strict()
  .refine(
    (value) => ['json', 'stdout', 'error'].filter((key) => Object.hasOwn(value, key)).length === 1,
    'Exactly one of json or stdout is required, or error alone for a simulated failure.',
  )
  .refine((value) => value.kind === undefined || value.error !== undefined, 'kind requires error.')
  .refine(
    (value) =>
      value.error === undefined || (value.stderr === undefined && value.code === undefined),
    'stderr and code require json or stdout; an error rule has no process result.',
  );

/** Validate untrusted fixture data before importing or executing workflow code. */
export function parseHarnessFixtures(value: unknown): HarnessFixtures {
  return z
    .object({
      version: z.literal(1),
      calls: z.array(rule),
      unmatched: z.enum(['error', 'synthesize']).optional(),
      exec: z.array(execRule).optional(),
      commands: z.literal('fixture').optional(),
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
        (entry.harness === undefined || entry.harness === request.harness) &&
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
    // A missing fixture is misconfiguration: never settle or retry it (see ConfigurationError).
    if (!fixture && this.fixtures.unmatched !== 'synthesize')
      return Promise.reject(
        new ConfigurationError(
          `No fixture matches step ${request.call.stepId} (${request.harness}, attempt ${String(request.call.attempt)}).`,
        ),
      );
    if (fixture?.error !== undefined) {
      const message = `Step ${request.call.stepId}: ${fixture.error}`;
      if (fixture.kind === undefined) return Promise.reject(new Error(message));
      const error = new HarnessError({
        harness: request.harness,
        kind: fixture.kind,
        exit: { code: 0, signal: null },
        failure: null,
        reason: fixture.error,
        stderr: '',
        stdout: '',
      });
      // The same text as a kindless rule, so settled messages and their export stay identical.
      error.message = message;
      return Promise.reject(error);
    }
    return Promise.resolve({
      text:
        fixture?.text ??
        (fixture && Object.hasOwn(fixture, 'output')
          ? request.outputSchema === null && typeof fixture.output === 'string'
            ? fixture.output
            : JSON.stringify(fixture.output)
          : request.outputSchema === null
            ? `[dry-run ${request.harness} ${request.call.stepId}]`
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
