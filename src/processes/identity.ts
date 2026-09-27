import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { HarnessProcess } from '../workflow/runtime/model.js';

interface ProcessIdentity {
  readonly pid: number;
  readonly pgid: number | null;
  readonly start: string | null;
  readonly zombie: boolean;
}

function code(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Distinguish absence from permission and observation failures. @internal */
export function pidState(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return code(error) === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function command(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim();
}

let bootIdentity: string | undefined;

function linuxIdentity(pid: number): ProcessIdentity {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  // comm is parenthesized and may itself contain spaces and right parentheses.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u);
  const ticks = fields[19];
  if (!ticks || !/^\d+$/u.test(ticks)) throw new Error('Invalid process stat');
  const boot = (bootIdentity ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  return {
    pid,
    pgid: Number(fields[2]),
    zombie: ['Z', 'X', 'x'].includes(fields[0] ?? ''),
    start: `linux:${boot}:${ticks}`,
  };
}

function darwinIdentities(pid?: number): ProcessIdentity[] {
  const boot = (bootIdentity ??= command('/usr/sbin/sysctl', ['-n', 'kern.boottime']));
  const rows = command('/bin/ps', [
    ...(pid === undefined ? ['-A'] : ['-p', String(pid)]),
    '-o',
    'pid=,pgid=,stat=,lstart=',
  ]);
  return rows.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error('Invalid ps process identity');
    return {
      pid: Number(match[1]),
      pgid: Number(match[2]),
      zombie: match[3]?.startsWith('Z') ?? false,
      start: `darwin:${boot}:${match[4] ?? ''}`,
    };
  });
}

/** Read OS birth identity without trusting an argv or wall-clock spawn timestamp. @internal */
export function processIdentity(pid: number): ProcessIdentity | null {
  try {
    if (process.platform === 'linux') return linuxIdentity(pid);
    if (process.platform === 'darwin') return darwinIdentities(pid)[0] ?? null;
    if (process.platform === 'win32') {
      const start = command('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]);
      return /^\d+$/u.test(start)
        ? { pid, pgid: null, zombie: false, start: `windows:${start}` }
        : null;
    }
  } catch {
    /* Missing or inaccessible identity must never authorize recovery signals. */
  }
  return null;
}

/** Observe an owned group, treating zombie-only groups as reaped. @internal */
export function groupState(
  child: Pick<HarnessProcess, 'pid' | 'pgid'>,
): 'alive' | 'dead' | 'unknown' {
  const state = pidState(child.pgid === null ? child.pid : -child.pgid);
  if (state !== 'alive') return state;
  if (child.pgid === null) return processIdentity(child.pid)?.zombie ? 'dead' : 'alive';
  try {
    let members: ProcessIdentity[];
    if (process.platform === 'linux') {
      members = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          members.push(linuxIdentity(Number(name)));
        } catch (error) {
          if (code(error) !== 'ENOENT' && code(error) !== 'ESRCH') throw error;
        }
      }
    } else if (process.platform === 'darwin') members = darwinIdentities();
    else return 'unknown';
    const group = members.filter((member) => member.pgid === child.pgid);
    if (!group.length) return pidState(-child.pgid) === 'dead' ? 'dead' : 'unknown';
    return group.some((member) => !member.zombie) ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

/** Signal only a group already owned by this live runner, or identity-verified recovery. @internal */
export function signalProcess(
  child: Pick<HarnessProcess, 'pid' | 'pgid'>,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(child.pgid === null ? child.pid : -child.pgid, signal);
  } catch (error) {
    if (code(error) !== 'ESRCH') throw error;
  }
}
