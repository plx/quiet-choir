/** Public process ownership and adapter utilities. Import from quiet-choir/harness-kit. */
export { runProcess } from './processes/run.js';
export type { ProcessRequest, ProcessResult } from './processes/run.js';
export { createFakeBinary } from './harness-kit/fake-binary.js';
export type { FakeBinary } from './harness-kit/fake-binary.js';
export { assertHarnessConformance } from './harness-kit/conformance.js';
export type {
  HarnessConformanceCase,
  HarnessConformanceFixture,
  HarnessConformanceOptions,
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
export type { ProtocolFailure } from './workflow/runtime/harness-error.js';
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
