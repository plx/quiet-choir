import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** A privately owned executable fixture; callers can add its directory to a subprocess PATH. */
export interface FakeBinary {
  /** Executable path. */
  readonly path: string;
  /** Directory suitable for PATH lookup. */
  readonly directory: string;
  /** PATH overlay; does not mutate the host environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Remove only this helper's temporary directory. */
  dispose(): Promise<void>;
}

/** Write a Node ESM fake CLI for adapter contract tests, without shell interpolation. */
export async function createFakeBinary(name: string, source: string): Promise<FakeBinary> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name))
    throw new Error('Fake binary name must be a simple lowercase executable name.');
  const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-fake-'));
  const path = join(directory, name);
  try {
    // ESM is explicit even though PATH executables usually have no extension.
    const module = join(directory, `${name}.mjs`);
    await writeFile(module, source, { mode: 0o600 });
    await writeFile(path, `#!/usr/bin/env node\nimport(${JSON.stringify(module)});\n`, {
      mode: 0o700,
    });
    return {
      path,
      directory,
      env: { PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}` },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
