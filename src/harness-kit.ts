/**
 * Public process ownership and adapter utilities. Import from quiet-choir/harness-kit.
 *
 * A third-party adapter launches its CLI with {@link runProcess}, building the child environment
 * with {@link childEnvironment} (pass `inheritEnv: false`) so host agent-session variables do not
 * leak. It frames JSONL stdout with {@link JsonLines}, and routes raw output, the native session ID
 * and progress through {@link createInvocationStream}, which honors the {@link HarnessInvocation}
 * contracts. {@link standaloneInvocation} stands in when `invoke` is called without an invocation,
 * and {@link promptedStructuredOutput} implements `structuredOutput: 'prompted'` for a CLI that
 * cannot enforce a JSON Schema itself.
 *
 * An exceeded byte budget is reported with {@link outputLimitError}: any `Error` whose `code` is
 * `'QUIET_CHOIR_OUTPUT_LIMIT'` ({@link outputLimitCode}) is recorded as the `output-limit` error
 * kind, which is distinct from malformed protocol output. Every value and type exported here is
 * checked against the published declarations, so none of them resolves to `any`.
 */
export { runProcess } from './processes/run.js';
export type { ProcessRequest, ProcessResult } from './processes/run.js';
export { createFakeBinary } from './harness-kit/fake-binary.js';
export type { FakeBinary } from './harness-kit/fake-binary.js';
export { assertHarnessConformance } from './harness-kit/conformance.js';
export type {
  HarnessConformanceCase,
  HarnessConformanceFixture,
  HarnessConformanceOptions,
  HarnessConformanceProbe,
} from './harness-kit/conformance.js';
export type * from './workflow/runtime/harness-model.js';
export type * from './workflow/runtime/model.js';
export type * from './workflow/runtime/agent-stream-model.js';
export type * from './workflow/runtime/agent-environment-model.js';
export type * from './workflow/runtime/usage-model.js';
export {
  HarnessError,
  attachHarnessEvidence,
  boundedResponse,
} from './workflow/runtime/harness-error.js';
export type { HarnessEvidence, ProtocolFailure } from './workflow/runtime/harness-error.js';
export { outputLimitCode, outputLimitError } from './processes/output-limit.js';
export { JsonLines } from './harnesses/lines.js';
export { childEnvironment } from './harnesses/environment.js';
export type { ScrubEnvironment } from './harnesses/environment.js';
export { createInvocationStream, standaloneInvocation } from './harness-kit/invocation.js';
export type { InvocationStream, InvocationStreamOptions } from './harness-kit/invocation.js';
export { promptedStructuredOutput } from './harness-kit/prompted.js';
export type { PromptedStructuredOutput } from './harness-kit/prompted.js';
// Adapters reject pre-launch validation with this so it is never settled or retried.
export { ConfigurationError } from './workflow/runtime/configuration-error.js';
export { defineHarness } from './harnesses/definition.js';
export { z } from 'zod';
// Shared built-in protocol support. These remain pure/adapter-side utilities, never orchestration.
export { validateAgentOptions } from './workflow/runtime/options.js';
export { environmentEdits } from './workflow/runtime/agent-environment.js';
export { checkAllowedTools } from './workflow/runtime/profiles.js';
export {
  tomlLiteral,
  effortValues,
  codexEffortValues,
  permissionModeValues,
} from './workflow/runtime/agent-controls.js';
export { snapshotImages } from './workflow/runtime/images.js';
export { resolveIsolation } from './workflow/runtime/agent-isolation.js';
export { jsonValue } from './workflow/runtime/json.js';
export { matchesStepGlob } from './workflow/runtime/policy.js';
export { knownSum, measurement, normalizeUsage, usageObject } from './workflow/runtime/usage.js';

export type { WorkflowDescription } from './workflow/runtime/child-model.js';
