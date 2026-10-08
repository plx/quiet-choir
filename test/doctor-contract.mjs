// Explicit opt-in. The installed Codex CLI runs the doctor's exact-argv probe against a loopback
// fake Responses API with a fresh configuration, a temporary HOME and a fake key. It proves that
// the request Codex sends carries the nonexistent sentinel model and the invalid effort, and
// checks the doctor's verdict whichever of the two the server rejects first. No real endpoint is
// contacted; run `npm run build` first.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probeHarnessContracts } from '../dist/index.js';
import { fakeApi } from './contracts/local-api.mjs';

const scenarios = [
  ['codex-doctor-effort-first', 'pass'],
  ['codex-doctor-model-first', 'warn'],
];
const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-doctor-contract-'));
// Keep host credentials and configuration away from the probe; Codex inherits process.env.
for (const name of Object.keys(process.env))
  if (/^(?:OPENAI_|CODEX_)/u.test(name)) delete process.env[name];
process.env['HOME'] = join(directory, 'home');
process.env['TMPDIR'] = join(directory, 'tmp');
await mkdir(process.env['HOME']);
await mkdir(process.env['TMPDIR']);
process.env['QUIET_CHOIR_FAKE_API_KEY'] = 'sk-quiet-choir-fake';
process.env['NO_COLOR'] = '1';
try {
  const { stdout } = await promisify(execFile)('codex', ['--version'], { cwd: directory });
  console.log(`codex version: ${stdout.trim()}`);
  for (const [name, enums] of scenarios) {
    const cwd = join(directory, name);
    const codexHome = join(cwd, 'configuration');
    await mkdir(codexHome, { recursive: true });
    const bodies = [];
    const api = await fakeApi(name, {
      onRequest: ({ url, body }) => {
        if (url.includes('/responses'))
          bodies.push({ model: body.model, reasoning: body.reasoning });
      },
    });
    try {
      await writeFile(
        join(codexHome, 'config.toml'),
        `model_provider = "fixture"\nmodel = "gpt-5.5"\n[model_providers.fixture]\nname = "Local contract API"\nbase_url = "${api.url}/v1"\nwire_api = "responses"\nenv_key = "QUIET_CHOIR_FAKE_API_KEY"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 2\n`,
      );
      const report = await probeHarnessContracts({ harness: 'codex', codexHome, cwd });
      const check = (id) => report.checks.find((entry) => entry.check === id);
      for (const entry of report.checks)
        console.log(`${name}: ${entry.status.toUpperCase()} ${entry.check}: ${entry.message}`);
      // The safety property: the only inference request names the sentinel and the bogus effort.
      // Codex may retry a 404; every attempt must carry both sentinels.
      assert(bodies.length > 0, `${name}: no /responses request reached the local API`);
      for (const body of bodies) {
        assert.match(body.model, /^quiet-choir-nonexistent-[0-9a-f-]{36}$/u, name);
        assert.equal(body.model, bodies[0].model, name);
        assert.equal(body.reasoning?.effort, 'bogus', name);
      }
      // The rejection judgement: zero spend, and the rejection this scenario's server sent.
      const argv = check('argv');
      assert.equal(report.zeroInference, true, `${name}: ${argv?.message}`);
      assert(
        argv?.message.startsWith(
          `Verified pre-inference rejection (${enums === 'pass' ? 'invalid effort' : 'sentinel model'}) with zero reported spend`,
        ),
        `${name}: ${argv?.message}`,
      );
      // A process or stderr warning fails the argv check on its own; it depends on the CLI
      // version and host, not on the sentinel, so it is reported rather than asserted.
      if (argv?.status !== 'pass') {
        assert.match(argv?.message ?? '', /; process\/stderr warning: /u, name);
        console.log(
          `${name}: argv check ${argv?.status} on a process warning (reported, not asserted)`,
        );
      }
      assert.equal(check('enums')?.status, enums, `${name}: ${check('enums')?.message}`);
      // A version outside the tested range fails its own check; report it, do not assert it.
      if (check('version')?.status !== 'pass')
        console.log(`${name}: version check ${check('version')?.status} (reported, not asserted)`);
      console.log(
        `${name}: ${String(bodies.length)} request(s), model ${bodies[0].model}, effort ${bodies[0].reasoning.effort}; verdict ${report.verdict}`,
      );
    } finally {
      await api.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
