// Spawned only by verify-idiomatic-faults.mjs; all writes stay inside its disposable fixture.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileRunStore, NodeProcessRunner } from 'quiet-choir';
import { drive, harnessFor, inputFor, killSpec, load, runOptions } from './idiomatic-fixtures.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { batch, name, root, cwd, stateDir } = config;
const resume = process.argv.includes('--resume');
// Every fixture field, including any a Batch 03 fixture module's setup added.
const env = { ...config, processRunner: new NodeProcessRunner() };
// A Batch 03 fixture module names its own kill point: a step ID pattern and a boundary.
const spec = killSpec(batch, name);
const killAt = spec && new RegExp(spec.step, 'u');
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
  // Synchronous, so a reply that threw is on disk before any kill; killCase reads it.
  onReplyError(entry) {
    appendFileSync(join(root, 'reply-errors.jsonl'), JSON.stringify(entry) + '\n');
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
  } else if (spec?.boundary === 'response' && killAt.test(id) && !existsSync(marker)) {
    die({ stepId: id, writeLocation: spec.writeLocation, boundary: 'before harness response' });
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
                  (name === 'sdlc-orchestrator' && stepId.endsWith('/write')) ||
                  (spec?.boundary === 'checkpoint' && killAt.test(stepId))),
            );
            if (batch >= 2 && completed && !existsSync(marker))
              die({
                stepId: completed[0],
                writeLocation:
                  spec?.writeLocation ??
                  (name === 'release-notes' ? 'source-checkout' : 'isolated-checkout'),
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
const input = await inputFor(batch, name, env);
if (batch >= 2 && name === 'test-gap-filler')
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
