// The opt-in live decision contract (#655) costs nothing without credentials: it reports itself
// skipped and exits 0 before loading dist, and a token without a configured host fails clearly
// rather than guessing a URL. Neither path makes a request or needs a build.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import { it } from './setup/state-dir.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(projectRoot, 'test/decision-live-contract.mjs');

/** The process environment without any decision token or harness configuration. */
function scrubbed(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (name !== 'TYPESAFE_API_KEY' && name !== 'QUIET_CHOIR_HARNESS_CONFIG') env[name] = value;
  return { ...env, ...extra };
}

function contract(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [script],
      { cwd: projectRoot, env, signal, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        done({ code: error === null ? 0 : (error.code as number | null), stdout, stderr });
      },
    );
  });
}

describe('test/decision-live-contract.mjs', () => {
  it('is skipped without a token', async ({ runs }) => {
    const result = await contract(scrubbed({}), runs.signal);
    expect(result).toEqual({
      code: 0,
      stdout: 'decision live contract: skipped (set TYPESAFE_API_KEY or decisions.jev.apiKeyEnv)\n',
      stderr: '',
    });
  });

  it('reads the token variable decisions.jev.apiKeyEnv names', async ({ runs }) => {
    const configuration = JSON.stringify({ decisions: { jev: { apiKeyEnv: 'QC_LIVE_TOKEN' } } });
    const skipped = await contract(
      scrubbed({ QUIET_CHOIR_HARNESS_CONFIG: configuration, TYPESAFE_API_KEY: 'unused' }),
      runs.signal,
    );
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toContain('skipped');
    const unconfigured = await contract(
      scrubbed({ QUIET_CHOIR_HARNESS_CONFIG: configuration, QC_LIVE_TOKEN: 'set' }),
      runs.signal,
    );
    expect(unconfigured).toMatchObject({ code: 1, stdout: '' });
    expect(unconfigured.stderr).toContain(
      'QC_LIVE_TOKEN is set but no host is configured; set decisions.jev.baseUrl',
    );
  });
});
