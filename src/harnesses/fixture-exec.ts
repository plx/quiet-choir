import { createHash } from 'node:crypto';
import type {
  ExecResult,
  ProcessRunRequest,
  ProcessRunner,
} from '../workflow/runtime/exec-model.js';
import { digest } from '../workflow/runtime/json.js';
import type { HarnessInvocation } from '../harness-kit.js';
import { ConfigurationError, matchesStepGlob } from '../harness-kit.js';
import { parseHarnessFixtures, type FixtureExecCall, type HarnessFixtures } from './fixture.js';

/** A matched command rule and its index in the fixture file's `exec` array. @internal */
export interface FixtureExecMatch {
  readonly rule: FixtureExecCall;
  readonly index: number;
}

/**
 * First-match command rules with per-rule occurrence counting and stale-rule tracking. The state is
 * per process: completed steps replay without reaching a process runner, so they are never counted.
 * @internal
 */
export class FixtureExecRules {
  readonly #rules: readonly FixtureExecCall[];
  /** Per rule, the distinct step IDs that met its step, argv and digest filters, in arrival order. */
  readonly #seen: string[][];
  readonly #used = new Set<number>();

  /** Rules in first-match order; `commands: 'fixture'` makes an unmatched command fatal. */
  public constructor(
    rules: readonly FixtureExecCall[] = [],
    public readonly commands?: 'fixture',
  ) {
    this.#rules = rules;
    this.#seen = rules.map(() => []);
  }

  /** Whether any rule or the fixture-only mode can affect a command. */
  public get active(): boolean {
    return this.#rules.length > 0 || this.commands === 'fixture';
  }

  /**
   * Record this command against every rule's occurrence list, then return the first rule that
   * matches it. Every list is updated, so a rule's occurrence never depends on the rules before it.
   */
  public match(
    request: ProcessRunRequest,
    invocation: Pick<HarnessInvocation, 'stepId' | 'attempt'>,
  ): FixtureExecMatch | undefined {
    if (!this.#rules.length) return undefined;
    const envSha256 = digest(request.env);
    const inputSha256 = createHash('sha256').update(request.input).digest('hex');
    let found: FixtureExecMatch | undefined;
    this.#rules.forEach((rule, index) => {
      if (!filtersMatch(rule, request, invocation.stepId, envSha256, inputSha256)) return;
      const seen = this.#seen[index] ?? [];
      if (!seen.includes(invocation.stepId)) seen.push(invocation.stepId);
      const occurrence = seen.indexOf(invocation.stepId) + 1;
      if (
        found === undefined &&
        (rule.attempt === undefined || rule.attempt === invocation.attempt) &&
        (rule.occurrence === undefined || rule.occurrence === occurrence)
      )
        found = { rule, index };
    });
    if (found) this.#used.add(found.index);
    return found;
  }

  /** The command result a rule describes; okExitCodes and schemas still apply downstream. */
  public result(rule: FixtureExecCall): ExecResult {
    return {
      code: rule.code ?? 0,
      signal: null,
      stdout: Object.hasOwn(rule, 'json') ? JSON.stringify(rule.json) : (rule.stdout ?? ''),
      stderr: rule.stderr ?? '',
      truncated: false,
      durationMs: 0,
    };
  }

  /** The fatal error for a command no rule matches under `commands: 'fixture'`. */
  public unmatched(
    request: ProcessRunRequest,
    invocation: Pick<HarnessInvocation, 'stepId' | 'attempt'>,
  ): ConfigurationError {
    return new ConfigurationError(
      `No exec fixture matches step ${invocation.stepId}: ${JSON.stringify(request.command)} (attempt ${String(invocation.attempt)}).`,
    );
  }

  /** Indices of rules that have matched no command so far. */
  public stale(): number[] {
    return this.#rules.map((_, index) => index).filter((index) => !this.#used.has(index));
  }
}

function filtersMatch(
  rule: FixtureExecCall,
  request: ProcessRunRequest,
  stepId: string,
  envSha256: string,
  inputSha256: string,
): boolean {
  if (!matchesStepGlob(rule.step, stepId)) return false;
  if (rule.argvPrefix !== undefined) {
    const command = request.command;
    if (!Array.isArray(command)) return false;
    const argv = command as readonly string[];
    if (argv.length < rule.argvPrefix.length) return false;
    if (rule.argvPrefix.some((value, index) => argv[index] !== value)) return false;
  }
  if (rule.envSha256 !== undefined && rule.envSha256 !== envSha256) return false;
  if (rule.inputSha256 !== undefined && rule.inputSha256 !== inputSha256) return false;
  return true;
}

/**
 * Process runner for `ctx.exec` under a fixture harness: matched commands are answered from exec
 * rules without spawning, unmatched ones fail under `commands: 'fixture'` and otherwise run through
 * the fallback. Worktree Git never goes through it. @internal
 */
export class FixtureProcessRunner implements ProcessRunner {
  readonly #rules: FixtureExecRules;
  readonly #fallback: ProcessRunner;

  /** Copy and validate the fixtures so later caller mutation cannot change routing. */
  public constructor(fixtures: HarnessFixtures, fallback: ProcessRunner) {
    const parsed = parseHarnessFixtures(fixtures);
    this.#rules = new FixtureExecRules(parsed.exec, parsed.commands);
    this.#fallback = fallback;
  }

  /** Answer from a rule, refuse in fixture-only mode, or delegate to the real runner. */
  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    invocation.signal.throwIfAborted();
    const match = this.#rules.match(request, invocation);
    if (match) return Promise.resolve(this.#rules.result(match.rule));
    if (this.#rules.commands === 'fixture')
      return Promise.reject(this.#rules.unmatched(request, invocation));
    return this.#fallback.run(request, invocation);
  }
}
