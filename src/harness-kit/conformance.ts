import assert from 'node:assert/strict';
import type { AgentRequest, HarnessAdapter } from '../workflow/runtime/harness-model.js';
import type { AgentOptions, JsonValue } from '../workflow/runtime/model.js';

/** Required fake CLI scenarios; do not point this suite at an inference-capable installation. */
export type HarnessConformanceCase =
  'text' | 'structured' | 'missing-usage' | 'protocol-error' | 'nonzero-stdout' | 'abort';

/** One test scenario's fake-backed installation and cleanup. */
export interface HarnessConformanceFixture<O extends AgentOptions> {
  /** Adapter connected only to test resources. */
  readonly adapter: HarnessAdapter<O>;
  /** Durable-shaped request for the scenario. */
  readonly request: AgentRequest<O>;
  /** Release caller-owned files after the invocation settles. */
  readonly dispose?: () => Promise<void>;
}

/** Adapter-specific fixture construction; the shared suite owns contract assertions. */
export interface HarnessConformanceOptions<O extends AgentOptions> {
  /** Construct a fake-backed adapter and request for each scenario. Abort must remain running until cancelled. */
  readonly fixture: (scenario: HarnessConformanceCase) => Promise<HarnessConformanceFixture<O>>;
  /** Expected plain response. */
  readonly text: string;
  /** Native failure reason expected in both protocol and nonzero-exit errors. */
  readonly failureReason: string;
  /** Expected JSON value in the structured response text. */
  readonly structured: JsonValue;
  /** Milliseconds allowed to settle cancellation; defaults to 2000. */
  readonly abortDeadlineMs?: number;
}

/** Run portable adapter contract assertions against caller-owned fakes, without a test-framework dependency. */
export async function assertHarnessConformance<O extends AgentOptions>(
  options: HarnessConformanceOptions<O>,
): Promise<void> {
  for (const scenario of [
    'text',
    'structured',
    'missing-usage',
    'protocol-error',
    'nonzero-stdout',
    'abort',
  ] as const) {
    const { adapter, request, dispose } = await options.fixture(scenario);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const invoked = Promise.resolve().then(() => adapter.invoke(request, controller.signal));
      if (scenario === 'abort') {
        timer = setTimeout(() => {
          controller.abort(new Error('conformance cancellation'));
        }, 25);
        const result = await Promise.race([
          invoked.then(
            () => 'resolved',
            () => (controller.signal.aborted ? 'aborted' : 'rejected-before-abort'),
          ),
          new Promise<string>((resolve) => {
            deadline = setTimeout(() => {
              resolve('deadline');
            }, options.abortDeadlineMs ?? 2000);
          }),
        ]);
        assert.notEqual(
          result,
          'rejected-before-abort',
          'Adapter rejected before cancellation; the abort fixture must stay running until aborted.',
        );
        assert.equal(result, 'aborted', 'Adapter must reject and promptly release work on abort.');
      } else if (scenario === 'protocol-error' || scenario === 'nonzero-stdout') {
        await assert.rejects(
          invoked,
          (error: unknown) =>
            error instanceof Error && error.message.includes(options.failureReason),
          `Adapter must reject ${scenario}, preserving native failure evidence.`,
        );
      } else {
        const result = await invoked;
        assert.equal(typeof result.text, 'string');
        assert.ok(
          result.sessionId === null || typeof result.sessionId === 'string',
          'Native session identity must be a string or null.',
        );
        if (scenario === 'structured')
          assert.deepEqual(JSON.parse(result.text), options.structured);
        else assert.equal(result.text, options.text);
        if (scenario === 'missing-usage') {
          for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const)
            assert.equal(
              result.usage?.[field] ?? null,
              null,
              `Unavailable ${field} must stay null.`,
            );
        }
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      controller.abort();
      await dispose?.();
    }
  }
}
