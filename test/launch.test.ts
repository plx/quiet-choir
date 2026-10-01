import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type * as oclif from '@oclif/core';
import { Errors, handle, run } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { drainOutput, launchCli } from '../src/cli/launch.js';
import { commandLauncher, setCommandLauncher } from '../src/cli/launcher.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

vi.mock('@oclif/core', async (importOriginal) => {
  const actual = await importOriginal<typeof oclif>();
  return {
    ...actual,
    flush: vi.fn(() => Promise.resolve()),
    handle: vi.fn(() => Promise.resolve()),
    run: vi.fn(() => Promise.resolve()),
  };
});

/** A pipe-like stream that accepts one chunk per macrotask, so queued writes lag behind write(). */
function slowStream(highWaterMark: number): { stream: Writable; written: () => number } {
  let written = 0;
  const stream = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      setTimeout(() => {
        written += chunk.length;
        callback();
      }, 1);
    },
  });
  return { stream, written: () => written };
}

describe('drainOutput', () => {
  it('waits until every earlier write has been processed', async () => {
    const { stream, written } = slowStream(1024);
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(4096));
    for (const chunk of chunks) stream.write(chunk);
    expect(written()).toBe(0);
    await drainOutput([stream]);
    expect(written()).toBe(20 * 4096);
  });

  it('waits for a queued remainder below the high-water mark, which flush() would skip', async () => {
    const { stream, written } = slowStream(16 * 1024);
    stream.write('x'.repeat(1000));
    stream.write('y'.repeat(1000));
    // An empty write reports no backpressure here, so a flush() based on its return value resolves
    // before these bytes are processed.
    expect(stream.writableLength).toBeLessThan(stream.writableHighWaterMark);
    await drainOutput([stream]);
    expect(written()).toBe(2000);
  });

  it('drains streams in order', async () => {
    const first = slowStream(1024);
    const second = slowStream(1024);
    first.stream.write('a'.repeat(8192));
    second.stream.write('b'.repeat(8192));
    await drainOutput([first.stream, second.stream]);
    expect(first.written()).toBe(8192);
    expect(second.written()).toBe(8192);
  });

  it('resolves at once for destroyed and ended streams', async () => {
    const destroyed = slowStream(1024).stream;
    destroyed.on('error', () => undefined);
    destroyed.destroy();
    const ended = slowStream(1024).stream;
    ended.end();
    await expect(drainOutput([destroyed, ended])).resolves.toBeUndefined();
  });

  it('resolves when the write fails, as with a closed pipe', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    stream.on('error', () => undefined);
    await expect(drainOutput([stream])).resolves.toBeUndefined();
  });

  it('resolves when write throws synchronously', async () => {
    const stream = {
      write: () => {
        throw new Error('closed');
      },
    } as unknown as NodeJS.WritableStream;
    await expect(drainOutput([stream])).resolves.toBeUndefined();
  });
});

describe('launchCli', () => {
  const argv = process.argv;
  const exitCode = process.exitCode;

  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(handle).mockReset();
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    // Other tests rely on the in-process default launcher.
    setCommandLauncher(undefined);
  });

  it('records the launcher of this invocation before dispatching', async () => {
    const script = join(projectRoot, 'bin/run.js');
    process.argv = [process.execPath, script, 'workflow', 'list'];
    await launchCli({ dir: import.meta.url });
    expect(commandLauncher()).toEqual([process.execPath, realpathSync(script)]);
    expect(run).toHaveBeenCalledWith(['workflow', 'list'], import.meta.url);
  });

  it('drains output and exits with the ExitError code without calling handle()', async () => {
    process.argv = ['node', 'run.js', 'workflow', 'resume', 'run-1', '--json'];
    vi.mocked(run).mockRejectedValue(new Errors.ExitError(74));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await launchCli({ dir: import.meta.url });
    expect(exit).toHaveBeenCalledWith(74);
    expect(process.exitCode).toBe(74);
    expect(handle).not.toHaveBeenCalled();
  });

  it('leaves other failures without --json on the handle() path', async () => {
    process.argv = ['node', 'run.js', 'workflow', 'resume', 'run-1'];
    const failure = new Error('boom');
    vi.mocked(run).mockRejectedValue(failure);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await launchCli({ dir: import.meta.url });
    expect(handle).toHaveBeenCalledWith(failure);
    expect(exit).not.toHaveBeenCalled();
  });
});
