import { readdirSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  durabilityLintFiles,
  lintDurability,
  parseDurabilitySuppression,
} from '../src/workflow/typecheck/durability-lint.js';
import type { DurabilityFinding } from '../src/workflow/typecheck/model.js';
import { configuredProgram } from '../src/workflow/typecheck/typescript-executor.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(projectRoot, 'test', 'fixtures', 'durability-lint');
const files = readdirSync(fixtures)
  .filter((name) => name.endsWith('.workflow.ts'))
  .sort()
  .map((name) => join(fixtures, name));

let program: ts.Program;
let findings: DurabilityFinding[];
let errors: string[];

function of(fixture: string): DurabilityFinding[] {
  return findings.filter((finding) => basename(finding.file) === `${fixture}.workflow.ts`);
}

function found(fixture: string): string[] {
  return of(fixture).map((finding) => `${finding.rule}@${String(finding.line)}`);
}

// One program over every fixture, as validate builds it under the root tsconfig, plus its type
// check. measured: 1.3 s alone; in a full coverage run the type check alone took 2.2 s.
beforeAll(() => {
  const configured = configuredProgram(files, join(projectRoot, 'tsconfig.json'));
  if ('error' in configured) throw new Error('tsconfig.json could not be read');
  program = configured.program;
  findings = lintDurability(program);
  errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}, 30_000);

describe('durability lint', () => {
  it('type-checks every fixture cleanly, so the lint sees a valid program', () => {
    expect(errors).toEqual([]);
  });

  it.each([
    ['m01-void', ['QC001@10']],
    ['m02-reused-id', ['QC005@11']],
    ['m03-loop-id', ['QC005@13']],
    ['m05-exists-sync', ['QC002@12']],
    ['m06-date-now', ['QC002@10']],
    ['m07-process-env', ['QC002@10']],
    ['m08-nested-step', ['QC003@13']],
    ['m08b-nested-exec', ['QC003@14']],
    ['m11-positional-map', ['QC006@11', 'QC005@12']],
    ['m20-race', ['QC004@10']],
  ])('flags the %s hazard', (fixture, expected) => {
    expect(found(fixture)).toEqual(expected);
  });

  it.each(['m11b-named-map', 'exclusive-branch', 'legitimate-apis'])(
    'finds nothing in the clean %s fixture',
    (fixture) => {
      expect(found(fixture)).toEqual([]);
    },
  );

  it('flags discarded effect, scope and phase promises, also through then chains', () => {
    // Statement, void + then, statement + catch, scope, phase with a body; awaited, kept,
    // Promise.all-ed and body-less phase calls are clean.
    expect(found('qc001-forms')).toEqual([
      'QC001@13',
      'QC001@14',
      'QC001@15',
      'QC001@16',
      'QC001@17',
    ]);
  });

  it('resolves each nondeterministic API by its declaration', () => {
    // new Date() in a ctx helper, Date(), performance.now() from node:perf_hooks, the global
    // crypto.randomUUID, node:crypto randomUUID, fs.readFileSync in a nested arrow; new Date(0)
    // is clean.
    expect(found('qc002-apis')).toEqual([
      'QC002@10',
      'QC002@23',
      'QC002@24',
      'QC002@25',
      'QC002@26',
      'QC002@29',
    ]);
    expect(of('qc002-apis').find((finding) => finding.line === 29)?.message).toContain(
      'readFileSync()',
    );
  });

  it('flags durable calls in every callback zone but not the callback context.exec', () => {
    // retryAfterMs (also a discarded promise), observe and done; context.exec in observe is clean.
    expect(found('qc003-zones')).toEqual(['QC001@19', 'QC003@19', 'QC003@25', 'QC003@35']);
    expect(of('qc003-zones').find((finding) => finding.rule === 'QC003')?.message).toContain(
      'PollErrorPolicy.retryAfterMs',
    );
  });

  it('flags Promise.race and any over direct, identifier and map-produced durable arrays', () => {
    expect(found('qc004-forms')).toEqual(['QC004@11', 'QC004@15']);
  });

  it('flags literal IDs in array callbacks, while loops and reuse on agent and exec receivers', () => {
    // claude.text in items.map, exec.json in a while loop, ctx.exec reused after an if that does
    // not return; within(ctx.id(...)) and ctx.id IDs in a loop are clean.
    expect(found('qc005-forms')).toEqual(['QC005@13', 'QC005@17', 'QC005@22']);
  });

  it('treats a callback as a loop only for standard-library iteration APIs', () => {
    // Array map and forEach, Set forEach and Array.from report; a user-defined class or object
    // map(), and a structurally typed receiver, call their callback once and are clean.
    expect(found('iteration-resolution')).toEqual(['QC005@29', 'QC005@30', 'QC005@31', 'QC005@32']);
  });

  it('resolves the context by type, whatever the parameter is called', () => {
    expect(found('renamed-context')).toEqual(['QC005@11', 'QC002@13']);
  });

  it('resolves the context through a local type alias', () => {
    expect(found('aliased-context')).toEqual(['QC005@13', 'QC002@15']);
  });

  it('silences exactly the rules a suppression comment names, on the next line only', () => {
    expect(found('suppression')).toEqual(['QC002@12']);
    // A comment naming another rule silences nothing; one listing the rule among others, or
    // giving no reason, silences it.
    expect(found('suppression-rules')).toEqual(['QC002@11']);
  });

  it('never lints quiet-choir sources the fixtures import', () => {
    const source = `${join(projectRoot, 'src')}${sep}`;
    expect(program.getSourceFiles().some((file) => file.fileName.startsWith(source))).toBe(true);
    expect(durabilityLintFiles(program).map((file) => file.fileName)).toEqual(files);
    expect(findings.filter((finding) => finding.file.startsWith(source))).toEqual([]);
  });

  it('returns sorted plain data with 1-based positions', () => {
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);
    expect(
      findings.find((finding) => basename(finding.file) === 'm06-date-now.workflow.ts'),
    ).toMatchObject({ rule: 'QC002', line: 10, column: 21 });
    const keys = findings.map((finding) => [finding.file, finding.line, finding.column]);
    expect(keys).toEqual(
      [...keys].sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) ||
          Number(a[1]) - Number(b[1]) ||
          Number(a[2]) - Number(b[2]),
      ),
    );
  });
});

describe('durability suppression comments', () => {
  it.each([
    ['// quiet-choir-ignore QC002 live clock', { rules: ['QC002'], reason: 'live clock' }],
    ['    //quiet-choir-ignore QC002,QC005  why  ', { rules: ['QC002', 'QC005'], reason: 'why' }],
    ['// quiet-choir-ignore QC001 , QC006', { rules: ['QC001', 'QC006'], reason: '' }],
    ['// quiet-choir-ignore QC002', { rules: ['QC002'], reason: '' }],
  ])('parses %j', (line, expected) => {
    expect(parseDurabilitySuppression(line)).toEqual(expected);
  });

  it.each([
    'const value = 1; // quiet-choir-ignore QC002 trailing',
    '// quiet-choir-ignore',
    '// quiet-choir-ignore QC0025 too many digits',
    '// quiet-choir-ignore qc002 lower case',
    '/* quiet-choir-ignore QC002 block comment */',
  ])('rejects %j', (line) => {
    expect(parseDurabilitySuppression(line)).toBeUndefined();
  });

  it('parses a long hostile line in linear time', () => {
    // A polynomial regex takes minutes at this size, so the bound discriminates by input size
    // rather than by a tight wall-clock budget that a loaded machine could trip.
    const repeats = 200_000;
    const line = `// quiet-choir-ignore QC001${' ,QC001'.repeat(repeats)}${' '.repeat(repeats)}!`;
    const started = performance.now();
    expect(parseDurabilitySuppression(line)?.rules).toHaveLength(repeats + 1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
