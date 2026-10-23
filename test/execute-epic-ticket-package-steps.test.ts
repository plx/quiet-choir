// The durable steps of the execute-epic-ticket package (packages/execute-epic-ticket.quiet-choir/lib,
// #590) run for real against a scratch Git repository with an origin remote, and against a fake
// `gh` on PATH for the GitHub mechanics.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  runWorkflow,
  z,
  type WorkflowContext,
} from '../src/index.js';

// The package imports `quiet-choir`, which resolves to dist/, and npm run check typechecks and
// tests before it builds. So the import maps to src/ here, and the modules load by a computed
// specifier the root typecheck does not follow; the package's own typecheck covers them.
vi.mock('quiet-choir', () => import('../src/index.js'));
vi.mock('quiet-choir/github', () => import('../src/integrations/github.js'));
const lib = async <T>(name: string): Promise<T> => {
  const url = new URL(
    `../packages/execute-epic-ticket.quiet-choir/lib/${name}.ts`,
    import.meta.url,
  );
  return (await import(url.href)) as T;
};

interface Paths {
  root: string;
  workdir: string;
  stateDir: string;
  epicDir: string;
}
interface Started {
  refused: string | null;
  branch: string;
  source: 'local' | 'remote' | 'new';
  resumed: boolean;
  ahead: number;
  behind: number;
  dirty: string[];
  rebase: string;
  baseSha: string;
  remoteSha: string | null;
}
type Settled<T> = { ok: true; value: T } | { ok: false; error: { message: string } };
const { start, verify, publish } = await lib<{
  start: (
    ctx: WorkflowContext,
    id: string,
    input: {
      paths: Paths;
      dir: string;
      base: string;
      epic: number;
      ticket: number;
      title: string;
    },
  ) => Promise<Started>;
  verify: (
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; base: string; commits: readonly string[] },
  ) => Promise<
    Settled<{
      head: string;
      branch: string | null;
      ahead: number;
      missingCommits: string[];
      dirty: string[];
    }>
  >;
  publish: (
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; branch: string; sha: string; lease: string | null },
  ) => Promise<Settled<{ head: string; pushed: boolean }>>;
}>('git');
const { runCheck } = await lib<{
  runCheck: (
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; branch: string; dir: string; label: string; command: string },
  ) => Promise<{
    passed: boolean;
    head: string | null;
    failedStep: string | null;
    error: string | null;
  }>;
}>('checks');
interface FoundIssue {
  number: number;
  title: string;
  url: string;
}
const {
  tick,
  insertChecklist,
  removeLabel,
  appendLedger,
  linkSubIssue,
  issueState,
  findOpenIssueByTitle,
  openSubIssues,
} = await lib<{
  findOpenIssueByTitle: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; title: string; subIssues?: readonly FoundIssue[] },
  ) => Promise<FoundIssue | null>;
  openSubIssues: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; parent: number },
  ) => Promise<FoundIssue[]>;
  linkSubIssue: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; parent: number; number: number },
  ) => Promise<{ changed: boolean; conflict: string | null }>;
  issueState: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; number: number },
  ) => Promise<{ number: number; title: string; state: string } | null>;
  tick: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; epic: number; ticket: number },
  ) => Promise<{ changed: boolean }>;
  insertChecklist: (
    ctx: WorkflowContext,
    id: string,
    input: {
      repo: string;
      epic: number;
      parent: number;
      entries: readonly { number: number; title: string }[];
    },
  ) => Promise<{ changed: boolean }>;
  removeLabel: (
    ctx: WorkflowContext,
    id: string,
    input: { repo: string; number: number; label: string },
  ) => Promise<{ changed: boolean }>;
  appendLedger: (
    ctx: WorkflowContext,
    id: string,
    input: { file: string; line: string },
  ) => Promise<{ appended: boolean; lines: number }>;
}>('github');

let real: string;
let runs = 0;
beforeEach(async () => {
  real = await realpath(await mkdtemp(join(tmpdir(), 'choir-epic-ticket-steps-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(real, { recursive: true, force: true });
});

/** Run `body` as a one-off workflow with its cwd in `cwd` and return its output. */
async function inWorkflow<T>(cwd: string, body: (ctx: WorkflowContext) => Promise<T>): Promise<T> {
  const run = await runWorkflow(
    defineWorkflow({
      name: 'epic-ticket-steps',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: body,
    }),
    {
      cwd,
      stateDir: join(real, 'runs'),
      runId: `test-${String(++runs)}`,
      input: null,
      processRunner: new NodeProcessRunner(),
    },
  );
  return run.output as T;
}

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A bare origin with one commit on main, and a clone of it (the main checkout). */
async function origin(): Promise<{ remote: string; checkout: string }> {
  const remote = join(real, 'origin.git');
  const checkout = join(real, 'checkout');
  await mkdir(checkout);
  sh(real, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, 'README.md'), 'hello\n');
  sh(checkout, 'add', '.');
  sh(checkout, 'commit', '-q', '-m', 'init');
  sh(checkout, 'remote', 'add', 'origin', remote);
  sh(checkout, 'push', '-q', 'origin', 'main');
  return { remote, checkout };
}

/** Commit `content` to `file` in `cwd`; returns the new HEAD. */
async function commit(
  cwd: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(cwd, file), content);
  sh(cwd, 'add', file);
  sh(cwd, 'commit', '-q', '-m', message);
  return sh(cwd, 'rev-parse', 'HEAD');
}

/** Advance origin/main from a second clone. */
async function advanceMain(remote: string, file: string, content: string): Promise<void> {
  const other = join(real, `other-${String(++runs)}`);
  sh(real, 'clone', '-q', remote, other);
  await commit(other, file, content, `upstream ${file}`);
  sh(other, 'push', '-q', 'origin', 'main');
}

const pathsAt = (root: string): Paths => ({
  root,
  workdir: join(root, 'worktree'),
  stateDir: join(root, 'state'),
  epicDir: join(root, 'state', 'epic-7'),
});
const startInput = (paths: Paths) => ({
  paths,
  dir: join(paths.epicDir, 'issue-9'),
  base: 'main',
  epic: 7,
  ticket: 9,
  title: 'Add a widget',
});
const BRANCH = 'epic-7/9-add-a-widget';

describe('start', () => {
  it('creates epic-E/N-slug from origin/main in a new worktree, then reuses it', async () => {
    const { checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    const first = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(first).toMatchObject({
      refused: null,
      branch: BRANCH,
      source: 'new',
      resumed: false,
      ahead: 0,
      rebase: 'up-to-date',
      remoteSha: null,
      baseSha: sh(checkout, 'rev-parse', 'HEAD'),
    });
    expect(sh(paths.workdir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    const again = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(again).toMatchObject({ refused: null, branch: BRANCH, source: 'local', ahead: 1 });
  });

  it('adopts a remote ticket branch another run pushed, recording its head for the lease', async () => {
    const { checkout } = await origin();
    sh(checkout, 'checkout', '-q', '-b', 'epic-7/9-an-older-title');
    const pushed = await commit(checkout, 'widget.ts', 'export {};\n', 'Add the widget');
    sh(checkout, 'push', '-q', 'origin', 'epic-7/9-an-older-title');
    sh(checkout, 'checkout', '-q', 'main');
    sh(checkout, 'branch', '-q', '-D', 'epic-7/9-an-older-title');
    const paths = pathsAt(join(real, 'root'));
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started).toMatchObject({
      refused: null,
      branch: 'epic-7/9-an-older-title',
      source: 'remote',
      resumed: true,
      ahead: 1,
      remoteSha: pushed,
    });
  });

  it('refuses a local branch that lacks commits another clone pushed, keeping them', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    const own = await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    sh(paths.workdir, 'push', '-q', 'origin', BRANCH);
    const held = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(held).toMatchObject({ refused: null, source: 'local', remoteSha: own });
    const other = join(real, 'other-clone');
    sh(real, 'clone', '-q', '-b', BRANCH, remote, other);
    const theirs = await commit(other, 'more.ts', 'export {};\n', 'Add more');
    sh(other, 'push', '-q', 'origin', BRANCH);
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started.refused).toContain(`origin/${BRANCH} has commits ${BRANCH} lacks`);
    expect(started.refused).toContain('Add more');
    expect(started.remoteSha).toBeNull();
    expect(sh(paths.workdir, 'rev-parse', 'HEAD')).toBe(own);
    expect(sh(checkout, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s+/)[0]).toBe(
      theirs,
    );
  });

  it('recognises its own earlier rebase of a pushed branch, keeping the old tip as the lease', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    const pushed = await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    sh(paths.workdir, 'push', '-q', 'origin', BRANCH);
    await advanceMain(remote, 'other.txt', 'upstream\n');
    const rebased = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(rebased).toMatchObject({ refused: null, rebase: 'rebased', remoteSha: pushed });
    const head = sh(paths.workdir, 'rev-parse', 'HEAD');
    expect(head).not.toBe(pushed);
    const again = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(again).toMatchObject({ refused: null, rebase: 'up-to-date', remoteSha: pushed });
    const published = await inWorkflow(checkout, (ctx) =>
      publish(ctx, 'push', { workdir: paths.workdir, branch: BRANCH, sha: head, lease: pushed }),
    );
    expect(published).toEqual({ ok: true, value: { head, pushed: true } });
  });

  it('accepts a remote tip whose commits are patch-equivalent to its own', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    const other = join(real, 'other-clone');
    sh(real, 'clone', '-q', remote, other);
    sh(other, 'checkout', '-q', '-b', BRANCH);
    const copy = await commit(other, 'widget.ts', 'export {};\n', 'Add the widget, again');
    sh(other, 'push', '-q', 'origin', BRANCH);
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started).toMatchObject({ refused: null, source: 'local', remoteSha: copy });
  });

  it('prunes the tracking ref of a ticket branch deleted on origin, so no lease is kept', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    const head = await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    sh(paths.workdir, 'push', '-q', 'origin', BRANCH);
    sh(remote, 'branch', '-q', '-D', BRANCH);
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started).toMatchObject({ refused: null, source: 'local', remoteSha: null });
    const published = await inWorkflow(checkout, (ctx) =>
      publish(ctx, 'push', { workdir: paths.workdir, branch: BRANCH, sha: head, lease: null }),
    );
    expect(published).toEqual({ ok: true, value: { head, pushed: true } });
  });

  it('rebases a reused branch onto a moved origin/main', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    await advanceMain(remote, 'other.txt', 'upstream\n');
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started).toMatchObject({ rebase: 'rebased', ahead: 1, behind: 0, source: 'local' });
    expect(existsSync(join(paths.workdir, 'other.txt'))).toBe(true);
  });

  it('reports a conflicting rebase without leaving it in progress', async () => {
    const { remote, checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    const own = await commit(paths.workdir, 'README.md', 'ours\n', 'Edit the readme');
    await advanceMain(remote, 'README.md', 'theirs\n');
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started).toMatchObject({ rebase: 'conflict', refused: null });
    expect(sh(paths.workdir, 'rev-parse', 'HEAD')).toBe(own);
    expect(sh(paths.workdir, 'status', '--porcelain')).toBe('');
    const gitDir = sh(paths.workdir, 'rev-parse', '--path-format=absolute', '--git-dir');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
  });

  it('refuses a dirty worktree on another branch', async () => {
    const { checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    sh(paths.workdir, 'checkout', '-q', '-b', 'epic-7/8-other-ticket');
    await writeFile(join(paths.workdir, 'README.md'), 'unfinished\n');
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started.refused).toContain('has uncommitted changes on epic-7/8-other-ticket');
    expect(sh(paths.workdir, 'symbolic-ref', '--short', 'HEAD')).toBe('epic-7/8-other-ticket');
  });

  it('refuses a ticket branch that another worktree has checked out', async () => {
    const { checkout } = await origin();
    sh(checkout, 'branch', '-q', BRANCH);
    const native = join(real, 'native-worktree');
    sh(checkout, 'worktree', 'add', '-q', native, BRANCH);
    const paths = pathsAt(join(real, 'root'));
    const started = await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    expect(started.refused).toContain(`branch ${BRANCH} is checked out in another worktree`);
    expect(started.refused).toContain(native);
  });
});

describe('verify, runCheck and publish', () => {
  async function ticket(): Promise<{ checkout: string; paths: Paths; head: string }> {
    const { checkout } = await origin();
    const paths = pathsAt(join(real, 'root'));
    await inWorkflow(checkout, (ctx) => start(ctx, 'start', startInput(paths)));
    const head = await commit(paths.workdir, 'widget.ts', 'export {};\n', 'Add the widget');
    return { checkout, paths, head };
  }

  it('verify reports missing commits, a dirty tree and a branch with nothing of its own', async () => {
    const { checkout, paths, head } = await ticket();
    const short = head.slice(0, 7);
    const clean = await inWorkflow(checkout, (ctx) =>
      verify(ctx, 'verify', { workdir: paths.workdir, base: 'main', commits: [short, 'deadbee'] }),
    );
    expect(clean).toMatchObject({
      ok: true,
      value: { head, branch: BRANCH, ahead: 1, missingCommits: ['deadbee'], dirty: [] },
    });
    await writeFile(join(paths.workdir, 'stray.txt'), 'x\n');
    const dirty = await inWorkflow(checkout, (ctx) =>
      verify(ctx, 'verify', { workdir: paths.workdir, base: 'main', commits: [] }),
    );
    expect(dirty).toMatchObject({ ok: true, value: { dirty: ['?? stray.txt'] } });
    await rm(join(paths.workdir, 'stray.txt'));
    sh(paths.workdir, 'reset', '-q', '--hard', 'origin/main');
    const empty = await inWorkflow(checkout, (ctx) =>
      verify(ctx, 'verify', { workdir: paths.workdir, base: 'main', commits: [short] }),
    );
    expect(empty).toMatchObject({ ok: true, value: { ahead: 0, missingCommits: [short] } });
  });

  it('runCheck passes, fails, and refuses a dirty tree or another branch', async () => {
    const { checkout, paths, head } = await ticket();
    const check = (command: string) =>
      inWorkflow(checkout, (ctx) =>
        runCheck(ctx, 'check', {
          workdir: paths.workdir,
          branch: BRANCH,
          dir: join(paths.epicDir, 'issue-9'),
          label: 'impl-1',
          command,
        }),
      );
    expect(await check('echo ok')).toMatchObject({ passed: true, head, failedStep: null });
    expect(await check('echo boom; false')).toMatchObject({ passed: false, head, error: null });
    await writeFile(join(paths.workdir, 'stray.txt'), 'x\n');
    expect(await check('echo ok')).toMatchObject({ passed: false, failedStep: 'dirty worktree' });
    await rm(join(paths.workdir, 'stray.txt'));
    sh(paths.workdir, 'checkout', '-q', '-b', 'epic-7/8-other-ticket');
    expect(await check('echo ok')).toMatchObject({
      passed: false,
      failedStep: 'foreign worktree',
      error: `the worktree is on epic-7/8-other-ticket, not ${BRANCH}`,
    });
  });

  it('publish pushes only the checked head, and skips a push that already happened', async () => {
    const { checkout, paths, head } = await ticket();
    const push = (sha: string) =>
      inWorkflow(checkout, (ctx) =>
        publish(ctx, 'push', { workdir: paths.workdir, branch: BRANCH, sha, lease: null }),
      );
    const stale = await push(sh(checkout, 'rev-parse', 'origin/main'));
    expect(stale).toMatchObject({ ok: false });
    expect(stale.ok ? '' : stale.error.message).toContain(
      'is not the head the check suite passed at',
    );
    expect(await push(head)).toEqual({ ok: true, value: { head, pushed: true } });
    expect(sh(checkout, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s+/)[0]).toBe(head);
    expect(await push(head)).toEqual({ ok: true, value: { head, pushed: false } });
    await writeFile(join(paths.workdir, 'stray.txt'), 'x\n');
    const dirty = await push(head);
    expect(dirty.ok ? '' : dirty.error.message).toContain('uncommitted changes');
  });
});

describe('appendLedger', () => {
  it('appends a line once, however often the step runs', async () => {
    const file = join(real, 'state', 'epic-7', 'ledger.jsonl');
    const line = JSON.stringify({ ticket: 9, pr: 42 });
    expect(await inWorkflow(real, (ctx) => appendLedger(ctx, 'ledger', { file, line }))).toEqual({
      appended: true,
      lines: 1,
    });
    expect(await inWorkflow(real, (ctx) => appendLedger(ctx, 'ledger', { file, line }))).toEqual({
      appended: false,
      lines: 1,
    });
    expect(await readFile(file, 'utf8')).toBe(`${line}\n`);
  });
});

describe('epic body and label mechanics', () => {
  /** A fake `gh` that serves an epic body from a file, records PATCHes, and 404s label deletes. */
  async function fakeGh(body: string, labels: readonly string[]) {
    const bin = join(real, 'bin');
    await mkdir(bin);
    const bodyFile = join(real, 'epic-body.json');
    const log = join(real, 'gh.log');
    await writeFile(bodyFile, JSON.stringify({ body }));
    const script = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const [bodyFile, log, labels] = ${JSON.stringify([bodyFile, log, labels])};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(log, args.join(' ') + '\\n');",
      "if (args.includes('PATCH')) {",
      "  const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      '  fs.writeFileSync(bodyFile, JSON.stringify({ body: input.body }));',
      "} else if (args.includes('DELETE')) {",
      "  process.stderr.write('gh: Label does not exist (HTTP 404)\\n');",
      '  process.exit(1);',
      "} else if (args.includes('{labels: [.labels[].name]}')) {",
      '  process.stdout.write(JSON.stringify({ labels }));',
      '} else {',
      "  process.stdout.write(fs.readFileSync(bodyFile, 'utf8'));",
      '}',
    ].join('\n');
    await writeFile(join(bin, 'gh'), `${script}\n`);
    await chmod(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    return {
      body: async () => (JSON.parse(await readFile(bodyFile, 'utf8')) as { body: string }).body,
      patches: async () =>
        (await readFile(log, 'utf8')).split('\n').filter((l) => l.includes('PATCH')).length,
    };
  }
  const repo = 'acme/widgets';

  it('tick PATCHes the epic once, and a retry finds it ticked', async () => {
    const gh = await fakeGh('## Items\n\n- [ ] #9 Add a widget\n- [ ] #10 Docs\n', []);
    const run = () => inWorkflow(real, (ctx) => tick(ctx, 'tick', { repo, epic: 7, ticket: 9 }));
    expect(await run()).toEqual({ changed: true });
    expect(await run()).toEqual({ changed: false });
    expect(await gh.body()).toBe('## Items\n\n- [x] #9 Add a widget\n- [ ] #10 Docs\n');
    expect(await gh.patches()).toBe(1);
  });

  it('insertChecklist PATCHes the epic once, and a retry finds the slices listed', async () => {
    const gh = await fakeGh('## Items\n\n- [ ] #9 Plugins\n- [ ] #10 Docs\n', []);
    const entries = [
      { number: 21, title: 'Registry' },
      { number: 22, title: 'Loader' },
    ];
    const run = () =>
      inWorkflow(real, (ctx) =>
        insertChecklist(ctx, 'checklist', { repo, epic: 7, parent: 9, entries }),
      );
    expect(await run()).toEqual({ changed: true });
    expect(await run()).toEqual({ changed: false });
    expect(await gh.body()).toBe(
      '## Items\n\n- [ ] #9 Plugins\n- [ ] #21 Registry\n- [ ] #22 Loader\n- [ ] #10 Docs\n',
    );
    expect(await gh.patches()).toBe(1);
  });

  it('removeLabel treats a 404 as success, and skips a label the issue lacks', async () => {
    await fakeGh('', ['needs-decision']);
    expect(
      await inWorkflow(real, (ctx) =>
        removeLabel(ctx, 'unlabel', { repo, number: 9, label: 'needs-decision' }),
      ),
    ).toEqual({ changed: false });
    expect(
      await inWorkflow(real, (ctx) =>
        removeLabel(ctx, 'unlabel', { repo, number: 9, label: 'on-hold' }),
      ),
    ).toEqual({ changed: false });
    const log = await readFile(join(real, 'gh.log'), 'utf8');
    expect(log.split('\n').filter((l) => l.includes('DELETE'))).toEqual([
      'api -X DELETE repos/acme/widgets/issues/9/labels/needs-decision --silent',
    ]);
  });

  it('reaches a host-qualified repository by --hostname and an owner/name path', async () => {
    await fakeGh('## Items\n\n- [ ] #9 Add a widget\n', ['needs-decision']);
    const hosted = 'ghe.example/acme/widgets';
    await inWorkflow(real, (ctx) => tick(ctx, 'tick', { repo: hosted, epic: 7, ticket: 9 }));
    await inWorkflow(real, (ctx) =>
      removeLabel(ctx, 'unlabel', { repo: hosted, number: 9, label: 'needs-decision' }),
    );
    const log = await readFile(join(real, 'gh.log'), 'utf8');
    expect(log.split('\n').filter(Boolean)).toEqual([
      'api --hostname ghe.example repos/acme/widgets/issues/7 --jq {body: .body}',
      'api --hostname ghe.example -X PATCH repos/acme/widgets/issues/7 --input - --silent',
      'api --hostname ghe.example repos/acme/widgets/issues/9 --jq {labels: [.labels[].name]}',
      'api --hostname ghe.example -X DELETE repos/acme/widgets/issues/9/labels/needs-decision --silent',
    ]);
  });
});

describe('sub-issue links and issue reads', () => {
  /**
   * A fake `gh` whose issue #21 has `parent` (null, or the node id and repository of one), whose
   * epic #7 is node I_7, whose #30 is a pull request and whose other numbers 404.
   */
  async function fakeGh(parent: { id: string; number: number; repo: string } | null) {
    const bin = join(real, 'bin');
    await mkdir(bin);
    const log = join(real, 'gh.log');
    const child = {
      id: 'I_21',
      parent: parent && {
        id: parent.id,
        number: parent.number,
        repository: { nameWithOwner: parent.repo },
      },
    };
    const script = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const [log, child] = ${JSON.stringify([log, child])};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(log, args.join(' ') + '\\n');",
      "const query = args.find((a) => a.startsWith('query=')) ?? '';",
      "if (query.startsWith('query=mutation')) {",
      "  process.stdout.write('{}');",
      "} else if (query.startsWith('query=query')) {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { child, wanted: { id: 'I_7' } } } }));",
      "} else if (args.includes('repos/acme/widgets/issues/21')) {",
      "  process.stdout.write(JSON.stringify({ number: 21, title: 'Registry', state: 'open', pull_request: null }));",
      "} else if (args.includes('repos/acme/widgets/issues/30')) {",
      "  process.stdout.write(JSON.stringify({ number: 30, title: 'A PR', state: 'open', pull_request: { url: 'x' } }));",
      '} else {',
      "  process.stderr.write('gh: Not Found (HTTP 404)\\n');",
      '  process.exit(1);',
      '}',
    ].join('\n');
    await writeFile(join(bin, 'gh'), `${script}\n`);
    await chmod(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    return {
      mutations: async () =>
        (await readFile(log, 'utf8')).split('\n').filter((l) => l.includes('query=mutation'))
          .length,
    };
  }
  const repo = 'acme/widgets';
  const link = () =>
    inWorkflow(real, (ctx) => linkSubIssue(ctx, 'link', { repo, parent: 7, number: 21 }));

  it('linkSubIssue changes nothing for an issue already under the parent', async () => {
    const gh = await fakeGh({ id: 'I_7', number: 7, repo });
    expect(await link()).toEqual({ changed: false, conflict: null });
    expect(await gh.mutations()).toBe(0);
  });

  it('linkSubIssue links an issue without a parent', async () => {
    const gh = await fakeGh(null);
    expect(await link()).toEqual({ changed: true, conflict: null });
    expect(await gh.mutations()).toBe(1);
    const log = await readFile(join(real, 'gh.log'), 'utf8');
    expect(log).toContain('issueId=I_7');
    expect(log).toContain('subIssueId=I_21');
  });

  it('linkSubIssue never moves an issue under another parent, and reports it', async () => {
    const gh = await fakeGh({ id: 'I_40', number: 40, repo: 'other/repo' });
    expect(await link()).toEqual({ changed: false, conflict: 'other/repo#40' });
    expect(await gh.mutations()).toBe(0);
  });

  it('issueState reads an issue, and is null for a 404 or a pull request', async () => {
    await fakeGh(null);
    const state = (number: number) =>
      inWorkflow(real, (ctx) => issueState(ctx, 'state', { repo, number }));
    expect(await state(21)).toEqual({ number: 21, title: 'Registry', state: 'OPEN' });
    expect(await state(99)).toBeNull();
    expect(await state(30)).toBeNull();
  });

  it('issueState reads a host-qualified repository through --hostname', async () => {
    await fakeGh(null);
    expect(
      await inWorkflow(real, (ctx) =>
        issueState(ctx, 'state', { repo: 'ghe.example/acme/widgets', number: 21 }),
      ),
    ).toEqual({ number: 21, title: 'Registry', state: 'OPEN' });
    expect((await readFile(join(real, 'gh.log'), 'utf8')).trim()).toBe(
      'api --hostname ghe.example repos/acme/widgets/issues/21 --jq {number,title,state,pull_request}',
    );
  });
});

describe('title lookup before filing', () => {
  const registry = { number: 21, title: 'Registry', url: 'https://github.com/acme/widgets/21' };
  /**
   * A fake `gh` whose search finds nothing (the index lags), whose plain listing has `recent`, and
   * whose epic #50 has `subIssues` (already in the `--jq` shape the step asks for).
   */
  async function fakeGh(recent: readonly FoundIssue[], subIssues: readonly unknown[] = []) {
    const bin = join(real, 'bin');
    await mkdir(bin);
    const log = join(real, 'gh.log');
    await writeFile(log, '');
    const script = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const [log, recent, subIssues] = ${JSON.stringify([log, recent, subIssues])};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(log, args.join(' ') + '\\n');",
      "if (args.includes('--search')) process.stdout.write('[]');",
      "else if (args[0] === 'issue') process.stdout.write(JSON.stringify(recent));",
      'else process.stdout.write(JSON.stringify(subIssues));',
    ].join('\n');
    await writeFile(join(bin, 'gh'), `${script}\n`);
    await chmod(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    return { calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean) };
  }
  const repo = 'acme/widgets';
  const find = (title: string, subIssues?: readonly FoundIssue[]) =>
    inWorkflow(real, (ctx) =>
      findOpenIssueByTitle(ctx, 'find', { repo, title, ...(subIssues ? { subIssues } : {}) }),
    );

  it('finds an issue the search index has not caught up with in the plain listing', async () => {
    const gh = await fakeGh([{ ...registry, number: 22, title: 'Registry v2' }, registry]);
    expect(await find('Registry')).toEqual(registry);
    const calls = await gh.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--search');
    expect(calls[1]).toBe(
      'issue list -R acme/widgets --state open --limit 100 --json number,title,url',
    );
  });

  it('is null when neither the search nor the listing has the exact title', async () => {
    await fakeGh([{ ...registry, title: 'Registry, again' }]);
    expect(await find('Registry')).toBeNull();
  });

  it("takes a match among the parent's sub-issues without reading GitHub", async () => {
    const gh = await fakeGh([]);
    expect(await find('Registry', [registry])).toEqual(registry);
    expect(await gh.calls()).toEqual([]);
  });

  it('openSubIssues keeps the open sub-issues of the repository', async () => {
    const raw = (number: number, state: string, owner = 'acme') => ({
      number,
      title: `Item ${String(number)}`,
      url: `https://github.com/${owner}/widgets/issues/${String(number)}`,
      state,
      repository_url: `https://api.github.com/repos/${owner}/widgets`,
    });
    await fakeGh([], [raw(21, 'open'), raw(22, 'closed'), raw(23, 'open', 'other')]);
    expect(
      await inWorkflow(real, (ctx) => openSubIssues(ctx, 'subs', { repo, parent: 50 })),
    ).toEqual([{ number: 21, title: 'Item 21', url: 'https://github.com/acme/widgets/issues/21' }]);
  });

  it('openSubIssues lists a host-qualified repository through --hostname', async () => {
    const hosted = {
      number: 21,
      title: 'Item 21',
      url: 'https://ghe.example/acme/widgets/issues/21',
      state: 'open',
      repository_url: 'https://ghe.example/api/v3/repos/acme/widgets',
    };
    const gh = await fakeGh([], [hosted, { ...hosted, number: 23, repository_url: 'x/repos/o/w' }]);
    expect(
      await inWorkflow(real, (ctx) =>
        openSubIssues(ctx, 'subs', { repo: 'ghe.example/acme/widgets', parent: 50 }),
      ),
    ).toEqual([{ number: 21, title: 'Item 21', url: hosted.url }]);
    expect((await gh.calls()).map((call) => call.split(' --jq ')[0])).toEqual([
      'api --hostname ghe.example repos/acme/widgets/issues/50/sub_issues?per_page=100',
    ]);
  });
});
