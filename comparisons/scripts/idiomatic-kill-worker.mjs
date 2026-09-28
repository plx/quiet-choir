// Spawned only by verify-idiomatic-faults.mjs; all writes stay inside its disposable fixture.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileRunStore, NodeProcessRunner } from 'quiet-choir';
import { drive, harnessFor, inputFor, load, runOptions } from './idiomatic-fixtures.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { batch, name, root, cwd, since, until, stateDir, worktrees } = config;
const resume = process.argv.includes('--resume');
const env = {
  root,
  cwd,
  since,
  until,
  stateDir,
  worktrees,
  processRunner: new NodeProcessRunner(),
};
const marker = join(root, 'kill-marker');
function die(point) {
  writeFileSync(marker, JSON.stringify(point));
  process.kill(process.pid, 'SIGKILL');
}
const { harness } = harnessFor(batch, name, env, {
  onCall(request) {
    appendFileSync(
      join(root, 'calls.jsonl'),
      JSON.stringify({ stepId: request.call.stepId }) + '\n',
    );
  },
});
const invoke = harness.invoke;
harness.invoke = async (request) => {
  const output = await invoke(request),
    id = request.call.stepId,
    prompt = request.options.prompt;
  if (batch === 1) {
    const writer =
      (name === 'release-notes' && prompt.startsWith('Add these release notes')) ||
      (name === 'project-bootstrap' && prompt.startsWith('Set up')) ||
      (name === 'test-gap-filler' && prompt.startsWith('Write tests')) ||
      (name === 'sdlc-orchestrator' && prompt.startsWith('Revise this PRD'));
    if (writer && !existsSync(marker)) {
      const path = join(cwd, name === 'test-gap-filler' ? 'target.mjs' : 'agent-written.txt');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        name === 'test-gap-filler' ? 'export const value = 0;\n' : 'partial agent write\n',
      );
      die({ stepId: id, writeLocation: 'source-checkout', boundary: 'before harness response' });
    }
  } else if (name === 'project-bootstrap' && id.endsWith('/apply') && !existsSync(marker)) {
    die({ stepId: id, writeLocation: 'isolated-checkout', boundary: 'before harness response' });
  }
  return output;
};
class KillStore extends FileRunStore {
  async open(id, options) {
    const owned = await super.open(id, options);
    return new Proxy(owned, {
      get(target, property) {
        if (property === 'append')
          return async (record, settings) => {
            const completed = Object.entries(record.steps).find(
              ([stepId, step]) =>
                step.status === 'completed' &&
                ((name === 'release-notes' && stepId === 'write') ||
                  (name === 'sdlc-orchestrator' && stepId.endsWith('/write'))),
            );
            if (batch === 2 && completed && !existsSync(marker))
              die({
                stepId: completed[0],
                writeLocation: name === 'release-notes' ? 'source-checkout' : 'isolated-checkout',
                boundary: 'after bytes, before terminal checkpoint append',
              });
            return target.append(record, settings);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
const input = inputFor(batch, name, env);
if (batch === 2 && name === 'test-gap-filler')
  input.testCommand = [process.execPath, 'kill-check.mjs'];
const opts = {
  ...runOptions(env, 'kill-case', harness, input),
  store: new KillStore(stateDir),
  resume,
  killOrphans: resume,
  killGraceMs: 20,
};
const { result } = await drive(await load(batch, name), opts);
writeFileSync(
  join(root, 'result.json'),
  JSON.stringify({
    status: result.status,
    output: result.output,
    steps: Object.fromEntries(
      Object.entries(result.steps).map(([id, step]) => [
        id,
        { status: step.status, attempts: step.attempts },
      ]),
    ),
  }),
);
