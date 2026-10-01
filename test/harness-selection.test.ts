import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  harnessConfigDigest,
  readHarnessSelection,
  type HarnessSelection,
} from '../src/workflow/loader/harness-selection.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const cli = (
  config: HarnessSelection['config'],
  extra: Partial<HarnessSelection> = {},
): HarnessSelection => ({ kind: 'cli', config, ...extra });

describe('harnessConfigDigest', () => {
  it('digests an absent selection like the default configuration, pinned as a golden value', async () => {
    // Changing the digested shape strands every recorded run behind --allow-harness-config-change,
    // so this golden must only move with a deliberate decision.
    const golden = 'd616b1e64ebd1f515febf33486b05d3f4efd5a63b997e6899849ff4389a3b175';
    expect(createHash('sha256').update('{"config":{},"configurations":{}}').digest('hex')).toBe(
      golden,
    );
    expect(harnessConfigDigest()).toBe(golden);
    expect(harnessConfigDigest(cli({}))).toBe(golden);
    expect(harnessConfigDigest(cli({}, { configurations: {} }))).toBe(golden);
    const cwd = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    directories.push(cwd);
    expect(harnessConfigDigest(await readHarnessSelection('cli', undefined, cwd))).toBe(golden);
    expect(harnessConfigDigest(await readHarnessSelection('cli', '{}', cwd))).toBe(golden);
  });

  it('ignores key order in config and configurations', () => {
    expect(
      harnessConfigDigest(
        cli(
          { claudeBinary: '/bin/claude', maxOutputBytes: 10 },
          { configurations: { third: { a: 1, b: 2 }, claude: { binary: '/x' } } },
        ),
      ),
    ).toBe(
      harnessConfigDigest(
        cli(
          { maxOutputBytes: 10, claudeBinary: '/bin/claude' },
          { configurations: { claude: { binary: '/x' }, third: { b: 2, a: 1 } } },
        ),
      ),
    );
  });

  it('excludes killGraceMs, the selection kind, fixtures and named fixtures', () => {
    const base = harnessConfigDigest(cli({ claudeBinary: '/bin/claude' }));
    expect(harnessConfigDigest(cli({ claudeBinary: '/bin/claude', killGraceMs: 50 }))).toBe(base);
    expect(
      harnessConfigDigest({
        kind: 'fixture',
        config: { claudeBinary: '/bin/claude' },
        fixtures: { version: 1, calls: [] },
        named: { third: { version: 1, calls: [], unmatched: 'synthesize' } },
      }),
    ).toBe(base);
  });

  it('changes with each configuration value that shapes execution', () => {
    const base = harnessConfigDigest(cli({}));
    const variants: HarnessSelection[] = [
      cli({ claudeBinary: '/bin/claude' }),
      cli({ codexBinary: '/bin/codex' }),
      cli({ maxOutputBytes: 1024 }),
      cli({ maxRetainedBytes: 1024 }),
      cli({ maxStreamBytes: 1024 }),
      cli({ scrubEnv: false }),
      cli({ scrubEnv: ['SECRET'] }),
      cli({}, { configurations: { third: { binary: 'third-cli' } } }),
      cli({}, { configurations: { third: { binary: 'other-cli' } } }),
    ];
    const digests = variants.map((variant) => harnessConfigDigest(variant));
    expect(new Set([base, ...digests]).size).toBe(variants.length + 1);
  });

  it('digests relative binary paths as resolved against the command cwd', async () => {
    const first = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    const second = await mkdtemp(join(tmpdir(), 'choir-selection-'));
    directories.push(first, second);
    const config = '{"claudeBinary":"./bin/claude"}';
    const fromFirst = harnessConfigDigest(await readHarnessSelection('cli', config, first));
    expect(fromFirst).toBe(
      harnessConfigDigest(cli({ claudeBinary: join(first, 'bin', 'claude') })),
    );
    expect(harnessConfigDigest(await readHarnessSelection('cli', config, second))).not.toBe(
      fromFirst,
    );
  });
});
