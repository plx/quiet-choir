// Explicit opt-in, and it makes one paid request. Runs one ctx.decide call through jevCompatible
// against a real host that speaks the shared decision protocol (ADR 0066): a single noul question
// about the state 'ping', the cheapest request there is. It runs only when the token variable is
// set: TYPESAFE_API_KEY, or the variable decisions.jev.apiKeyEnv names in QUIET_CHOIR_HARNESS_CONFIG
// (JSON, or @file as the CLI accepts it). Without a token it reports itself skipped and exits 0
// before loading dist. It is never part of npm test, npm run check or CI. Run `npm run build` first:
//
//   QUIET_CHOIR_HARNESS_CONFIG='{"decisions":{"jev":{"baseUrl":"https://..."}}}' \
//     TYPESAFE_API_KEY=... npm run test:contract:decision
//
// The repository does not record a host URL; set decisions.jev.baseUrl (and optionally
// decisions.jev.defaultModel, default jev-latest).
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function harnessConfiguration() {
  const value = process.env['QUIET_CHOIR_HARNESS_CONFIG'];
  if (value === undefined || value === '') return {};
  const text = value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`QUIET_CHOIR_HARNESS_CONFIG is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

const configuration = (await harnessConfiguration())?.decisions?.jev ?? {};
const apiKeyEnv = configuration.apiKeyEnv ?? 'TYPESAFE_API_KEY';
const token = process.env[apiKeyEnv];
if (token === undefined || token === '') {
  console.log('decision live contract: skipped (set TYPESAFE_API_KEY or decisions.jev.apiKeyEnv)');
  process.exit(0);
}
if (typeof configuration.baseUrl !== 'string' || configuration.baseUrl === '') {
  console.error(
    `decision live contract: ${apiKeyEnv} is set but no host is configured; set decisions.jev.baseUrl in QUIET_CHOIR_HARNESS_CONFIG (the repository records no host URL).`,
  );
  process.exit(1);
}

const { defineWorkflow, runWorkflow, z } = await import('../dist/index.js');
const { jevCompatible, noul } = await import('../dist/integrations/decision.js');

const jev = jevCompatible({ name: 'jev', apiKeyEnv, defaultModel: 'jev-latest' });
const definition = defineWorkflow({
  name: 'decision-live-contract',
  version: '1',
  input: z.null(),
  output: z.unknown(),
  decisions: [jev],
  run: (ctx) =>
    ctx.decide('ping', {
      state: 'ping',
      questions: { alive: noul({ instructions: 'Is this a ping?' }) },
      timeoutMs: 60_000,
    }),
});

const stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-decision-contract-'));
try {
  const result = await runWorkflow(definition, {
    stateDir,
    runId: 'ping',
    input: null,
    decisionConfigurations: { jev: { ...configuration, apiKeyEnv } },
  });
  assert.equal(result.status, 'completed');
  const answer = result.output?.alive?.noul;
  assert.ok(
    typeof answer === 'number' && answer >= 0 && answer <= 1,
    `expected a probability, got ${JSON.stringify(result.output)}`,
  );
  const step = result.steps['ping'];
  const usage = step?.attemptHistory?.at(-1)?.usage;
  console.log(
    `decision live contract: passed (noul ${String(answer)}; requested ${configuration.defaultModel ?? 'jev-latest'}, served ${String(step?.output?.model ?? 'unknown')}; ${String(usage?.inputTokens ?? '?')} in / ${String(usage?.outputTokens ?? '?')} out tokens)`,
  );
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
