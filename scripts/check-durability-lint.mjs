// Corpus gate for the static durability lint (ADR 0041): every examples/ and Workflow Lab ported
// workflow must lint clean, and every suppression must give a reason. It builds one program per
// tsconfig with the same construction and lint that `workflow validate` uses, so the whole corpus
// costs three compiles instead of one CLI launch per workflow. Run after `npm run build`: the
// comparison batches import 'quiet-choir', which resolves to dist.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  durabilityLintFiles,
  lintDurability,
  parseDurabilitySuppression,
} from '../src/workflow/typecheck/durability-lint.ts';
import { configuredProgram } from '../src/workflow/typecheck/typescript-executor.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflows = (directory) =>
  readdirSync(join(repository, directory))
    .filter((name) => name.endsWith('.workflow.ts'))
    .sort()
    .map((name) => join(repository, directory, name));
const groups = [
  {
    config: 'tsconfig.json',
    files: [...workflows('examples'), ...workflows('examples/patterns')],
  },
  ...['01-direct-ports', '02-idiomatic-ports'].map((batch) => ({
    config: `comparisons/batches/${batch}/tsconfig.json`,
    files: workflows(`comparisons/batches/${batch}/ported`),
  })),
];

const problems = [];
const location = (file, line, column) =>
  `${relative(repository, file)}:${String(line)}${column === undefined ? '' : `:${String(column)}`}`;
let checked = 0;
for (const group of groups) {
  if (group.files.length === 0) {
    problems.push(`${group.config}: no *.workflow.ts files found`);
    continue;
  }
  const configured = configuredProgram(group.files, join(repository, group.config));
  if ('error' in configured) {
    problems.push(
      `${group.config}: ${ts.flattenDiagnosticMessageText(configured.error.messageText, '\n')}`,
    );
    continue;
  }
  const { program } = configured;
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      problems.push(`${group.config}: TS${String(diagnostic.code)}: ${message}`);
      continue;
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    problems.push(
      `${location(diagnostic.file.fileName, position.line + 1, position.character + 1)}: TS${String(diagnostic.code)}: ${message}`,
    );
  }
  for (const finding of lintDurability(program))
    problems.push(
      `${location(finding.file, finding.line, finding.column)}: ${finding.rule}: ${finding.message}`,
    );
  for (const file of durabilityLintFiles(program)) {
    checked += 1;
    file.text.split(/\r?\n/).forEach((text, index) => {
      if (!text.includes('quiet-choir-ignore')) return;
      const suppression = parseDurabilitySuppression(text);
      if (suppression === undefined)
        problems.push(
          `${location(file.fileName, index + 1)}: malformed quiet-choir-ignore comment; write // quiet-choir-ignore QCnnn <reason> on its own line`,
        );
      else if (suppression.reason === '')
        problems.push(
          `${location(file.fileName, index + 1)}: quiet-choir-ignore ${suppression.rules.join(', ')} needs a reason`,
        );
    });
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`Durability lint failed: ${String(problems.length)} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`Durability lint passed: ${String(checked)} workflow source files, 0 findings.`);
}
