// The runner test/step-exec-lifecycle.test.ts SIGKILLs while its step's inner command, or its
// command poll's command, hangs.
import { NodeProcessRunner, runWorkflow } from '../src/index.ts';
import { fingerprint, lifecycle, pollLifecycle } from './step-exec-workflow.ts';

const [stateDir, cwd, ready, resumed, mode] = process.argv.slice(2);
await runWorkflow(mode === 'poll' ? pollLifecycle : lifecycle, {
  runId: 'lifecycle',
  stateDir,
  cwd,
  input: { ready, resumed },
  fingerprint,
  processRunner: new NodeProcessRunner(),
});
