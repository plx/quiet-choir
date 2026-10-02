// The runner test/step-exec-lifecycle.test.ts SIGKILLs while its step's inner command hangs.
import { NodeProcessRunner, runWorkflow } from '../src/index.ts';
import { fingerprint, lifecycle } from './step-exec-workflow.ts';

const [stateDir, cwd, ready, resumed] = process.argv.slice(2);
await runWorkflow(lifecycle, {
  runId: 'lifecycle',
  stateDir,
  cwd,
  input: { ready, resumed },
  fingerprint,
  processRunner: new NodeProcessRunner(),
});
