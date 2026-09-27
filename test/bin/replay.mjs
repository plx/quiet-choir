import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function matches(pattern, value) {
  if (typeof pattern !== 'string' || !/^[a-zA-Z0-9*][a-zA-Z0-9._:/*-]{0,199}$/u.test(pattern))
    throw new Error('Invalid fixture step glob');
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        expression += '(?:.*/)?';
        index++;
      } else expression += '.*';
    } else expression += char === '*' ? '[^/]*' : char === '.' ? '\\.' : char;
  }
  return new RegExp(`${expression}$`, 'u').test(value);
}

/** Repository-only native-protocol replay. Never invokes another binary or accesses an API. */
export async function replay(provider) {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) {
    const sample = JSON.parse(
      await readFile(
        new URL(`../fixtures/harness/${provider}-text-success.json`, import.meta.url),
        'utf8',
      ),
    );
    console.log(`${provider} ${sample.version} (quiet-choir captured fixture)`);
    return;
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const bytes of process.stdin) stdin += bytes.toString('utf8');
  const at = (flag) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const schema =
    provider === 'claude'
      ? at('--json-schema')
      : at('--output-schema') === undefined
        ? undefined
        : await readFile(at('--output-schema'), 'utf8');
  const identity = {
    runId: process.env['QUIET_CHOIR_RUN_ID'] ?? null,
    stepId: process.env['QUIET_CHOIR_STEP_ID'] ?? null,
    attempt: process.env['QUIET_CHOIR_ATTEMPT'] ?? null,
  };
  let scenario = process.env['QUIET_CHOIR_FAKE_SCENARIO'];
  if (process.env['QUIET_CHOIR_FAKE_ROUTES']) {
    const routes = JSON.parse(
      await readFile(resolve(process.env['QUIET_CHOIR_FAKE_ROUTES']), 'utf8'),
    );
    if (routes.version !== 1 || !Array.isArray(routes.calls))
      throw new Error('Fake CLI routes require version:1 and calls.');
    const rule = routes.calls.find(
      (rule) =>
        (rule.provider === undefined || rule.provider === provider) &&
        (rule.step === undefined || matches(rule.step, identity.stepId ?? '')) &&
        (rule.prompt === undefined || new RegExp(rule.prompt, 'u').test(stdin)),
    );
    scenario = rule?.scenario ?? scenario;
  }
  scenario ??= `${provider}-${schema === undefined ? 'text' : 'structured'}-success`;
  if (!/^[a-z0-9-]+$/u.test(scenario)) throw new Error('Invalid capture scenario name.');
  const capture = JSON.parse(
    await readFile(new URL(`../fixtures/harness/${scenario}.json`, import.meta.url), 'utf8'),
  );
  if (
    capture.provider !== provider ||
    typeof capture.version !== 'string' ||
    !Number.isInteger(capture.code) ||
    typeof capture.stdout !== 'string' ||
    typeof capture.stderr !== 'string'
  )
    throw new Error(`Invalid ${provider} capture: ${scenario}`);
  if (process.env['QUIET_CHOIR_FAKE_LOG'])
    await appendFile(
      resolve(process.env['QUIET_CHOIR_FAKE_LOG']),
      JSON.stringify({
        provider,
        version: capture.version,
        scenario,
        ...identity,
        argv,
        cwd: process.cwd(),
        stdin,
        schema: schema === undefined ? null : JSON.parse(schema),
      }) + '\n',
      { mode: 0o600 },
    );
  process.stdout.write(capture.stdout);
  process.stderr.write(capture.stderr);
  process.exitCode = capture.code;
}
