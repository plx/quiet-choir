import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { snapshotImages } from '../src/workflow/runtime/images.js';

const probe = vi.hoisted(() => ({
  events: [] as string[],
  // Which phase of slow.png's read waits for the gate; a gate that never opens models a stalled mount.
  stage: 'open',
  gate: Promise.resolve(),
}));

// Observe every handle the snapshot opens, and hold one phase of the slow source behind a gate.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const name = basename(String(args[0]));
      probe.events.push(`open ${name}`);
      const slow = name === 'slow.png';
      if (slow && probe.stage === 'open') await probe.gate;
      const handle = await actual.open(...args);
      probe.events.push(`opened ${name}`);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        probe.events.push(`close ${name}`);
      };
      if (slow && probe.stage === 'stat') {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...options: Parameters<typeof stat>) => {
          await probe.gate;
          return await stat(...options);
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-images-'));
  probe.events = [];
  probe.stage = 'open';
  probe.gate = Promise.resolve();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Hold the slow source's `stage` until the returned release runs. */
function hold(stage: 'open' | 'stat'): () => void {
  let release!: () => void;
  probe.stage = stage;
  probe.gate = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

it.each([
  ['open', 'missing.png', 'slow.png'],
  ['open', 'slow.png', 'missing.png'],
  ['stat', 'missing.png', 'slow.png'],
  ['stat', 'slow.png', 'missing.png'],
] as const)(
  'rejects a failed snapshot without waiting for a sibling stuck in %s (%s, %s)',
  async (stage, ...paths) => {
    await writeFile(join(directory, 'slow.png'), Buffer.alloc(1024, 1));
    const release = hold(stage);
    const failure: unknown = await snapshotImages(paths, directory).catch(
      (error: unknown) => error,
    );
    // The real failure wins over the sibling's cancellation, whichever order they were listed.
    expect(failure).toMatchObject({ code: 'ENOENT' });
    expect((failure as Error).message).toContain('missing.png');
    // The stalled operation is abandoned, and its handle is still closed once it returns.
    release();
    await vi.waitFor(() => {
      expect(probe.events).toContain('close slow.png');
    });
  },
);

it.each(['open', 'stat'] as const)(
  'rejects with the caller reason when interrupted during a never-settling %s',
  async (stage) => {
    await writeFile(join(directory, 'slow.png'), 'slow');
    hold(stage);
    const run = new AbortController();
    const snapshot = snapshotImages(['slow.png'], directory, run.signal);
    await vi.waitFor(() => {
      expect(probe.events).toContain(stage === 'open' ? 'open slow.png' : 'opened slow.png');
    });
    const reason = new Error('run interrupted');
    run.abort(reason);
    await expect(snapshot).rejects.toBe(reason);
    // An opened handle is closed in the background even though its stat never settles.
    if (stage === 'stat') {
      await vi.waitFor(() => {
        expect(probe.events).toContain('close slow.png');
      });
    }
  },
);

it('snapshots every image when all reads succeed', async () => {
  await writeFile(join(directory, 'a.png'), 'a');
  await writeFile(join(directory, 'b.png'), 'b');
  const attachments = await snapshotImages(['a.png', 'b.png'], directory);
  expect(
    attachments.map((attachment) => Buffer.from(attachment.base64, 'base64').toString()),
  ).toEqual(['a', 'b']);
  expect(probe.events.filter((event) => event.startsWith('close'))).toHaveLength(2);
});
