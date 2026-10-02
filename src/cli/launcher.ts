import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { defaultCommandLauncher, type CommandLauncher } from '../workflow/runtime/commands.js';

/** Process facts that decide the launcher, injected so detection stays a pure table. @internal */
export interface LauncherProbe {
  /** `process.argv[1]`: the script Node was asked to run. */
  readonly argv1: string | undefined;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  /** Development mode (`bin/dev.js` under tsx), whose loader flags must survive. */
  readonly development: boolean;
  /** The `PATH` value to search for an installed `quiet-choir`. */
  readonly pathEnv: string | undefined;
  /** Resolve symlinks; throws when the path does not exist. */
  readonly realpath: (path: string) => string;
  /** Whether a path is an executable regular file. */
  readonly isExecutable: (path: string) => boolean;
}

/** npm's per-package shim directory, which npm and npx prepend to PATH only while they run. */
function packageShimDirectory(directory: string): boolean {
  return basename(directory) === '.bin' && basename(dirname(directory)) === 'node_modules';
}

function installedOnPath(probe: LauncherProbe): string | undefined {
  for (const directory of (probe.pathEnv ?? '').split(delimiter)) {
    if (!directory || packageShimDirectory(directory)) continue;
    const candidate = join(directory, 'quiet-choir');
    if (probe.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The program words that rerun this CLI from any directory. An installed `quiet-choir` that PATH
 * resolves to this very script stays `['quiet-choir']`; anything else (a checkout's `bin/run.js`,
 * an npx or `node_modules/.bin` shim, a PATH entry for another checkout) becomes
 * `[execPath, realpath(script)]`, with development loader flags in between. An unknown script
 * keeps the default. @internal
 */
export function detectCommandLauncher(probe: LauncherProbe): CommandLauncher {
  if (!probe.argv1) return defaultCommandLauncher;
  let script: string;
  try {
    script = probe.realpath(probe.argv1);
  } catch {
    return defaultCommandLauncher;
  }
  if (basename(probe.argv1) === 'quiet-choir') {
    const installed = installedOnPath(probe);
    try {
      if (installed !== undefined && probe.realpath(installed) === script)
        return defaultCommandLauncher;
    } catch {
      /* A dangling PATH entry is not this installation. */
    }
  }
  return [probe.execPath, ...(probe.development ? probe.execArgv : []), script];
}

/**
 * The program words that spawn this CLI as a child process: always
 * `[execPath, ...(development ? execArgv : []), realpath(argv1)]`, never the bare `quiet-choir`
 * PATH word. Spawning Node directly needs no PATH lookup, keeps development loader flags, and makes
 * the child's PID the PID of the CLI process itself (a shell shim would put another process in
 * between). Undefined when `argv1` is missing or cannot be resolved. @internal
 */
export function detectSpawnLauncher(probe: LauncherProbe): CommandLauncher | undefined {
  if (!probe.argv1) return undefined;
  let script: string;
  try {
    script = probe.realpath(probe.argv1);
  } catch {
    return undefined;
  }
  return [probe.execPath, ...(probe.development ? probe.execArgv : []), script];
}

/** Probe the current process. @internal */
export function processLauncherProbe(development: boolean): LauncherProbe {
  return {
    argv1: process.argv[1],
    execPath: process.execPath,
    execArgv: process.execArgv,
    development,
    pathEnv: process.env['PATH'],
    realpath: (path) => realpathSync(path),
    isExecutable: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Launchers detected by `launchCli`, kept on `globalThis` under a registered symbol: in development
 * mode oclif loads command modules through its own TypeScript loader, a second instance of this
 * module, which must still see what `launchCli` recorded.
 */
const launchers = Symbol.for('quiet-choir.cli.launchers');

interface LauncherState {
  command?: CommandLauncher | undefined;
  spawn?: CommandLauncher | undefined;
}

function state(): LauncherState {
  const holder = globalThis as unknown as Record<symbol, LauncherState | undefined>;
  return (holder[launchers] ??= {});
}

/** Record the launcher of this CLI process; only `launchCli` sets it. @internal */
export function setCommandLauncher(launcher: CommandLauncher | undefined): void {
  state().command = launcher;
}

/** The detected launcher, or undefined (the runtime default) outside a launched CLI. @internal */
export function commandLauncher(): CommandLauncher | undefined {
  return state().command;
}

/** Record the spawn launcher of this CLI process; only `launchCli` sets it. @internal */
export function setSpawnLauncher(launcher: CommandLauncher | undefined): void {
  state().spawn = launcher;
}

/** The detected spawn launcher, or undefined outside a launched CLI or without a script path. @internal */
export function spawnLauncher(): CommandLauncher | undefined {
  return state().spawn;
}
