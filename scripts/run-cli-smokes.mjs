#!/usr/bin/env node
// Run every test/*smoke.mjs against the built CLI, in parallel, each with its own state directory.
//
//   node scripts/run-cli-smokes.mjs [--concurrency N] [--dir DIR] [filter...]
//
// A filter is a substring of the smoke's file name, so `npm run test:cli -- worktrees` runs one
// smoke; a filter equal to a smoke's exact name (with or without `.mjs`) selects only that smoke.
// New smokes need no registration: any file in test/ whose name ends in `smoke.mjs` runs.
// Environment: QUIET_CHOIR_SMOKE_CONCURRENCY (default min(4, availableParallelism())) and
// QUIET_CHOIR_SMOKE_TIMEOUT_MS (per smoke, default 10 minutes).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultTimeoutMs = 10 * 60_000;
const tailLines = 100;
const maxBufferedCharacters = 4_000_000;

/** Names of the smoke scripts in `dir`, sorted. */
export function discoverSmokes(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('smoke.mjs'))
    .sort();
}

/**
 * Whether `filter` selects the smoke `name`. A filter that is a smoke's exact file name, with or
 * without `.mjs`, selects only that smoke (so `cli-smoke` does not also run `x-cli-smoke.mjs`);
 * any other filter is a substring of the file name.
 */
function selectsSmoke(filter, name, all) {
  if (all.some((smoke) => smoke === filter || smoke === `${filter}.mjs`))
    return name === filter || name === `${filter}.mjs`;
  return name.includes(filter);
}

/** The default per-project state root: `<XDG_STATE_HOME or ~/.local/state>/quiet-choir`. */
export function realStateRoot(env = process.env) {
  const xdg = env['XDG_STATE_HOME'];
  return join(xdg ? resolve(xdg) : join(homedir(), '.local', 'state'), 'quiet-choir');
}

function entries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Two-level listing of a state root: each project directory and each project's `runs/` entries.
 * A smoke running from the repository root adds a run inside an existing project directory, so a
 * top-level listing alone would miss it.
 */
export function stateSnapshot(root) {
  const listing = [];
  for (const project of entries(root)) {
    listing.push(project);
    for (const run of entries(join(root, project, 'runs'))) listing.push(`${project}/runs/${run}`);
  }
  return listing.sort();
}

/** Entries present in `after` but not in `before`. Deletions are a developer's own cleanup. */
export function addedEntries(before, after) {
  const known = new Set(before);
  return after.filter((entry) => !known.has(entry));
}

function tail(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-tailLines).join('\n');
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function positiveInteger(label, value) {
  const number = Number(value);
  if (value === '' || !Number.isInteger(number) || number < 1)
    throw new Error(`The ${label} must be a positive integer, not ${String(value)}.`);
  return number;
}

function killGroup(child, signal = 'SIGKILL') {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* Already gone. */
    }
  }
}

/**
 * Run the smokes and resolve to `{ exitCode, results }`. Logging goes through `log`, so tests can
 * capture it. `env` is the runner's own environment: it decides the real state root that the guard
 * watches, and the children inherit it minus every QUIET_CHOIR_* variable.
 */
export async function runSmokes({
  dir = join(projectRoot, 'test'),
  filters = [],
  concurrency,
  timeoutMs,
  env = process.env,
  cwd = projectRoot,
  log = (line) => {
    console.log(line);
  },
} = {}) {
  const limit = positiveInteger(
    'concurrency',
    concurrency ?? env['QUIET_CHOIR_SMOKE_CONCURRENCY'] ?? Math.min(4, availableParallelism()),
  );
  const smokeTimeout = positiveInteger(
    'smoke timeout',
    timeoutMs ?? env['QUIET_CHOIR_SMOKE_TIMEOUT_MS'] ?? defaultTimeoutMs,
  );
  const all = discoverSmokes(dir);
  if (all.length === 0) {
    log(`No *smoke.mjs files found in ${dir}.`);
    return { exitCode: 1, results: [] };
  }
  const names = all.filter(
    (name) => filters.length === 0 || filters.some((f) => selectsSmoke(f, name, all)),
  );
  if (names.length === 0) {
    log(`No smoke matches ${filters.join(', ')}. Available: ${all.join(', ')}`);
    return { exitCode: 1, results: [] };
  }

  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('QUIET_CHOIR_')),
  );
  const stateRoot = realStateRoot(env);
  const before = stateSnapshot(stateRoot);
  const started = Date.now();
  const running = new Set();
  const results = [];
  let aborted = null;

  const onSignal = (signal) => {
    aborted ??= signal;
    for (const child of running) killGroup(child);
  };
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      onSignal(signal);
    };
    process.on(signal, handler);
    return [signal, handler];
  });

  const runOne = (name) =>
    new Promise((done) => {
      const xdg = mkdtempSync(join(tmpdir(), `choir-smoke-${name.replace(/\.mjs$/u, '')}-`));
      const begin = Date.now();
      let output = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(process.execPath, [join(dir, name)], {
        cwd,
        env: { ...childEnv, XDG_STATE_HOME: xdg },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running.add(child);
      const collect = (chunk) => {
        output += chunk.toString('utf8');
        if (output.length > maxBufferedCharacters) output = output.slice(-maxBufferedCharacters);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, smokeTimeout);
      const finish = (code, signal, spawnError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        running.delete(child);
        const ms = Date.now() - begin;
        const ok = code === 0 && !timedOut && spawnError === undefined;
        const reason = spawnError
          ? `spawn failed: ${spawnError.message}`
          : timedOut
            ? `timed out after ${seconds(smokeTimeout)}`
            : signal
              ? `killed by ${signal}`
              : `exit ${String(code)}`;
        if (ok) rmSync(xdg, { force: true, recursive: true });
        log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${seconds(ms)}${ok ? '' : ` (${reason})`}`);
        const result = { name, ok, ms, reason, output, xdg: ok ? null : xdg };
        results.push(result);
        done(result);
      };
      child.on('error', (error) => {
        finish(null, null, error);
      });
      child.on('close', (code, signal) => {
        finish(code, signal);
      });
    });

  const queue = [...names];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (aborted) return;
      await runOne(name);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }

  const wall = Date.now() - started;
  const summed = results.reduce((total, result) => total + result.ms, 0);
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    log(`\n--- ${result.name}: ${result.reason}; last ${tailLines} lines of output ---`);
    log(tail(result.output));
    log(`--- state kept at ${result.xdg} ---`);
  }
  let exitCode = failed.length === 0 && results.length === names.length ? 0 : 1;
  if (aborted) {
    log(`Interrupted by ${aborted}.`);
    exitCode = 1;
  }
  const added = addedEntries(before, stateSnapshot(stateRoot));
  if (added.length > 0) {
    log(
      `\nThe smokes added entries to the real state root ${stateRoot}:\n${added.map((e) => `  ${e}`).join('\n')}\n` +
        'A smoke must isolate its state (XDG_STATE_HOME or --state-dir). If you started an unrelated quiet-choir run meanwhile, this can be a false positive: rerun.',
    );
    exitCode = 1;
  }
  const count = `${String(results.length)} of ${String(names.length)} smokes`;
  log(
    failed.length === 0 && results.length === names.length
      ? `\n${String(names.length)} smokes passed in ${seconds(wall)} wall (${seconds(summed)} summed, concurrency ${String(limit)}).`
      : `\n${String(failed.length)} failed; ${count} ran in ${seconds(wall)} wall (${seconds(summed)} summed, concurrency ${String(limit)}).`,
  );
  return { exitCode, results };
}

function parseArguments(argv) {
  const options = { filters: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--concurrency') options.concurrency = Number(value());
    else if (arg?.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14));
    else if (arg === '--dir') options.dir = resolve(value());
    else if (arg?.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else if (arg !== undefined) options.filters.push(arg);
  }
  return options;
}

async function main() {
  try {
    return (await runSmokes(parseArguments(process.argv.slice(2)))).exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const entryScript = process.argv[1];
if (
  entryScript !== undefined &&
  realpathSync(entryScript) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}
