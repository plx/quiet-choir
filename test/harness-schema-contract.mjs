// Explicit opt-in only: Codex probes reject before inference; Claude probes make small paid calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { z } from '../dist/index.js';
import { prepareCodexSchema } from '../dist/harnesses/codex-schema.js';
import { runProcess } from '../dist/harnesses/process.js';
import { parseClaude, parseCodex } from '../dist/harnesses/protocol.js';

const provider = process.argv[2];
assert(
  ['--codex', '--claude'].includes(provider),
  'Pass --codex (zero-inference schema validation) or --claude (small paid calls).',
);
const binary = provider.slice(2);
const selected = process.argv[3]?.split(',');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
const matrix = JSON.parse(
  await readFile(new URL('./fixtures/codex-schema-matrix.json', import.meta.url), 'utf8'),
);
const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-contract-'));
const report = {
  provider: binary,
  version,
  zodVersion: matrix.zodVersion,
  date: new Date().toISOString(),
  cases: [],
};
let failures = 0;
try {
  for (const entry of matrix.cases.filter((entry) => !selected || selected.includes(entry.name))) {
    const variants =
      binary === 'codex' && !entry.rules.includes('tuple') ? ['strict', 'compat'] : ['strict'];
    for (const mode of variants) {
      const wire = mode === 'compat' ? prepareCodexSchema(entry.schema, mode).schema : entry.schema;
      const path = join(directory, 'schema.json');
      await writeFile(path, JSON.stringify(wire));
      const args =
        binary === 'codex'
          ? [
              'exec',
              '--json',
              '--sandbox',
              'read-only',
              '--config',
              'approval_policy="never"',
              '--config',
              'model_reasoning_effort="bogus"',
              '--ephemeral',
              '--color',
              'never',
              '--skip-git-repo-check',
              '--output-schema',
              path,
              '-',
            ]
          : [
              '--print',
              '--output-format',
              'json',
              '--model',
              'haiku',
              '--tools',
              '',
              '--permission-mode',
              'dontAsk',
              '--strict-mcp-config',
              '--setting-sources',
              '',
              '--max-turns',
              '3',
              '--max-budget-usd',
              '0.05',
              '--no-session-persistence',
              '--json-schema',
              JSON.stringify(wire),
            ];
      try {
        const result = await runProcess({
          binary,
          args,
          cwd: directory,
          input: `Return only this data using the requested structured output: ${JSON.stringify(entry.output)}`,
          timeoutMs: 60000,
          maxOutputBytes: 1024 * 1024,
          killGraceMs: 250,
          signal: new AbortController().signal,
        });
        const outcome =
          binary === 'codex' ? parseCodex(result.stdout) : parseClaude(result.stdout, true);
        if (binary === 'codex') {
          assert.equal(result.code, 1);
          const message = outcome.kind === 'failure' ? outcome.failure.reason : result.stdout;
          const rejected =
            result.stdout.includes('invalid_json_schema') ||
            message.includes('Invalid schema for response_format');
          const accepted = !rejected && message.includes("Invalid value: 'bogus'");
          assert(rejected || accepted, 'Probe failed before schema/effort validation: ' + message);
          const expectedRejection = mode === 'strict' && entry.rules.length > 0;
          assert.equal(
            rejected,
            expectedRejection,
            `${entry.name}/${mode}: unexpected schema acceptance`,
          );
          report.cases.push({
            name: entry.name,
            mode,
            status: rejected ? 'schema-rejected' : 'schema-accepted',
            code: result.code,
          });
        } else if (outcome.kind === 'success' && result.code === 0) {
          const decoded = JSON.parse(outcome.response.text);
          const validation = z.fromJSONSchema(entry.schema).safeParse(decoded);
          assert(
            validation.success,
            'Claude output failed original JSON Schema validation: ' +
              JSON.stringify(validation.error),
          );
          report.cases.push({
            name: entry.name,
            status: 'success',
            code: result.code,
            usage: outcome.response.usage,
          });
        } else if (
          outcome.kind === 'failure' &&
          outcome.failure.apiStatus === 400 &&
          outcome.failure.reason.includes('input_schema.type')
        ) {
          report.cases.push({
            name: entry.name,
            status: 'schema-rejected',
            code: result.code,
            reason: outcome.failure.reason,
            usage: outcome.failure.usage,
          });
        } else {
          failures++;
          report.cases.push({
            name: entry.name,
            status: 'inconclusive',
            code: result.code,
            outcome,
          });
        }
      } catch (error) {
        failures++;
        report.cases.push({
          name: entry.name,
          mode,
          status: 'inconclusive',
          reason: error.message,
        });
      }
      console.log(JSON.stringify(report.cases.at(-1)));
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
  if (process.env['QUIET_CHOIR_CONTRACT_REPORT'])
    await writeFile(
      process.env['QUIET_CHOIR_CONTRACT_REPORT'],
      JSON.stringify(report, null, 2) + '\n',
    );
}
process.exitCode = failures ? 1 : 0;
