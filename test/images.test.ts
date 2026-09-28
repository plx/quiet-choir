import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { snapshotImages } from '../src/workflow/runtime/images.js';

const probe = vi.hoisted(() => ({
  events: [] as string[],
  gate: Promise.resolve(),
}));

// Observe every handle the snapshot opens, and hold the slow source's open behind a gate.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const name = basename(String(args[0]));
      probe.events.push(`open ${name}`);
      if (name === 'slow.png') await probe.gate;
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        probe.events.push(`close ${name}`);
      };
      return handle;
    },
  };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-images-'));
  probe.events = [];
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ['missing.png', 'slow.png'],
  ['slow.png', 'missing.png'],
])(
  'cancels and drains sibling reads before rejecting a failed snapshot (%s, %s)',
  async (...paths) => {
    await writeFile(join(directory, 'slow.png'), Buffer.alloc(1024, 1));
    let open!: () => void;
    probe.gate = new Promise((resolve) => {
      open = resolve;
    });
    const snapshot = snapshotImages(paths, directory).catch((error: unknown) => {
      probe.events.push('rejected');
      throw error;
    });
    // Let the missing read fail while the slow read is still opening.
    await vi.waitFor(() => {
      expect(probe.events).toContain('open missing.png');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(probe.events).not.toContain('rejected');
    open();
    const failure: unknown = await snapshot.catch((error: unknown) => error);
    // The real failure wins over the sibling's cancellation, whichever order they were listed.
    expect(failure).toMatchObject({ code: 'ENOENT' });
    expect((failure as Error).message).toContain('missing.png');
    expect(probe.events.indexOf('close slow.png')).toBeGreaterThan(-1);
    expect(probe.events.indexOf('close slow.png')).toBeLessThan(probe.events.indexOf('rejected'));
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
