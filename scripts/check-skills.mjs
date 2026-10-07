import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { checkLinks, fences, headingSlugs, inside, prose } from './skill-markdown.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const packages = ['agents', 'claude'].map((host) => `plugins/${host}/quiet-choir`);
const skillPath = 'skills/quiet-choir';
/** Shell fences whose lines may not start with a bare launcher the reader may not have installed. */
const shellLanguages = new Set(['sh', 'bash', 'shell', 'zsh', 'console']);
const bareLauncher = /^\s*(?:\$\s+)?quiet-choir(?:\s|$)/u;
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The patterns index (the table before the first H2) must link every H2 recipe section. Links in
 * the intro's prose do not count: a section mentioned there would otherwise hide a missing row.
 */
function checkPatternsIndex(text, file) {
  const intro = prose(text, file).split(/^ {0,3}## /mu)[0];
  const rows = intro.split('\n').filter((line) => /^ {0,3}\|/u.test(line));
  const linked = new Set(
    rows.flatMap((row) =>
      [...row.matchAll(/\]\(#([^)\s]+)\)/gu)].map((match) => decodeURIComponent(match[1])),
    ),
  );
  for (const { level, title, slug } of headingSlugs(text))
    requireThat(
      level !== 2 || linked.has(slug),
      `${file}: patterns index does not link recipe section "${title}" (#${slug})`,
    );
}
async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    requireThat(
      !entry.isSymbolicLink(),
      `${file}: packages must contain physical files, not symlinks`,
    );
    if (entry.isDirectory()) result.push(...(await files(root, file)));
    else if (entry.isFile()) result.push(relative(root, file));
    else throw new Error(`${file}: unsupported package entry`);
  }
  return result.sort();
}
function frontmatter(text, file) {
  const match = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  requireThat(match, `${file}: missing YAML frontmatter`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  requireThat(!document.errors.length, `${file}: invalid YAML: ${document.errors.join('; ')}`);
  const schema = z
    .object({
      name: z.literal('quiet-choir'),
      description: z.string().trim().min(1).max(1024),
    })
    .strict();
  const result = schema.safeParse(document.toJS());
  requireThat(result.success, `${file}: invalid skill frontmatter: ${result.error?.message ?? ''}`);
}
/**
 * Claude Code command frontmatter: an explicit schema, so a misspelled or unsupported key fails
 * instead of being silently ignored by the host.
 */
function commandFrontmatter(text, file) {
  const match = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  requireThat(match, `${file}: missing YAML frontmatter`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  requireThat(!document.errors.length, `${file}: invalid YAML: ${document.errors.join('; ')}`);
  const schema = z
    .object({
      description: z.string().trim().min(1).max(1024),
      'argument-hint': z.string().optional(),
      'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict();
  const result = schema.safeParse(document.toJS());
  requireThat(
    result.success,
    `${file}: invalid command frontmatter: ${result.error?.message ?? ''}`,
  );
}
/** Claude Code substitutes these in a command body, fences included, before the shell sees them. */
const commandSubstitution = /\$(?:ARGUMENTS\b|\d|\{\d)/u;
/**
 * Claude Code runs a `!` followed by a backtick span, and a fence whose info string starts with
 * `!`, when it loads a command or skill, before the model reads the file. It finds them with a text
 * match over the whole body and respects neither fences nor comments, so no context is exempt:
 * prose, inline code, shell fences, HTML comments and frontmatter are all rejected.
 */
function checkPreExecution(text, file) {
  text.split('\n').forEach((line, index) => {
    const where = `${file}:${String(index + 1)}`;
    requireThat(
      !line.includes('!`'),
      `${where}: Claude Code runs !\`...\` at load time, before the model reads the file; put the command in a shell fence for the model to run, with exported QC_* variables as commands/run.md does`,
    );
    // A raw, unanchored line scan, not the Markdown fence parser: Claude Code's match ignores nesting,
    // indent and any text before the marker, so a fence inside a comment or prose is still run.
    requireThat(
      !/(?:`{3,}|~{3,})[ \t]*!/u.test(line),
      `${where}: Claude Code runs a fence whose info string starts with ! at load time, before the model reads the file; use a shell fence for the model to run, with exported QC_* variables as commands/run.md does`,
    );
  });
}
/** Reject a shell fence line that starts with a bare launcher the reader may not have installed. */
function checkShellFence(fence, file) {
  if (!shellLanguages.has(fence.language) || fence.installed) return;
  fence.code.split('\n').forEach((line, offset) => {
    requireThat(
      !bareLauncher.test(line),
      `${file}:${String(fence.line + offset)}: shell fence invokes bare quiet-choir; use node "$QC_CHECKOUT/bin/run.js", or annotate the fence with <!-- skills-check: installed-mode -->`,
    );
  });
}
async function manifests(root) {
  const portableFile = join(root, packages[0], 'plugin.json');
  const portable = await json(portableFile);
  const schema = await json(join(repository, 'test/fixtures/skills/agent-plugin.schema.json'));
  const result = z.fromJSONSchema(schema).safeParse(portable);
  requireThat(result.success, `${portableFile}: invalid manifest: ${result.error?.message ?? ''}`);
  // The Claude plugin ships a skill and commands discovered from their default directories.
  // Expanding its manifest requires extending this explicit schema; unknown component fields must
  // not silently bypass validation.
  const common = {
    name: z.literal('quiet-choir'),
    version: z.string(),
    description: z.string(),
    author: z
      .object({ name: z.string().min(1), email: z.string().optional(), url: z.string().optional() })
      .strict(),
    homepage: z.url(),
    repository: z.string(),
    license: z.string(),
    keywords: z.array(z.string()),
  };
  const claudeFile = join(root, packages[1], '.claude-plugin/plugin.json');
  const claude = await json(claudeFile);
  const checked = z.object(common).strict().safeParse(claude);
  requireThat(checked.success, `${claudeFile}: invalid manifest: ${checked.error?.message ?? ''}`);
  // Each host describes what its package ships; every other common field must match.
  for (const key of Object.keys(common).filter((name) => name !== 'description'))
    requireThat(
      JSON.stringify(portable[key]) === JSON.stringify(claude[key]),
      `manifest metadata differs: ${key}`,
    );
  for (const [index, catalog] of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
  ].entries()) {
    const data = await json(join(root, catalog));
    const entry = data.plugins?.find((plugin) => plugin.name === 'quiet-choir');
    const source = index === 0 ? entry?.source?.path : entry?.source;
    requireThat(source === `./${packages[index]}`, `${catalog}: invalid marketplace source`);
    if (index === 0)
      requireThat(entry.source.source === 'local', `${catalog}: expected local source`);
  }
}
const differenceMarkerLike = /skills-difference/iu;
function normalizeDifferences(text, file, rules, seen) {
  const used = new Set();
  const normalized = text.replace(
    /<!-- skills-difference: ([a-z0-9-]+) -->\n([^]*?)<!-- \/skills-difference: \1 -->/gu,
    (_match, id, body) => {
      requireThat(
        !differenceMarkerLike.test(body),
        `${file}: nested or malformed difference marker in region ${id}`,
      );
      const key = `${file}:${id}`;
      requireThat(rules.has(key), `${file}: unlisted difference region ${id}`);
      requireThat(!used.has(id), `${file}: duplicate difference region ${id}`);
      used.add(id);
      seen.add(key);
      return `<!-- approved difference: ${id} -->`;
    },
  );
  requireThat(!differenceMarkerLike.test(normalized), `${file}: malformed difference marker`);
  return normalized;
}
/** Specifiers of the package root, as documented and as written in checkout examples. */
const rootSpecifiers = [
  'quiet-choir',
  '../src/index.js',
  '../../src/index.js',
  '/absolute/path/to/quiet-choir/dist/index.js',
];
/** Specifiers of the `quiet-choir/github` subpath, which sits beside the root as integrations/github.js. */
const githubSpecifiers = [
  'quiet-choir/github',
  '../src/integrations/github.js',
  '../../src/integrations/github.js',
  '/absolute/path/to/quiet-choir/dist/integrations/github.js',
];
/**
 * Replace import specifiers only; prompt strings and executable code stay intact. The root maps to
 * `runtime` and `quiet-choir/github` to `integrations/github.js` in the same directory, so
 * `src/index.js` pairs with `src/integrations/github.js` and `dist/index.js` with its built copy.
 */
export function sourceExample(code, runtime = join(repository, 'src/index.js')) {
  const github = join(dirname(runtime), 'integrations/github.js');
  const source = ts.createSourceFile(
    'example.mts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = [];
  function visit(node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    const target =
      specifier && ts.isStringLiteral(specifier)
        ? rootSpecifiers.includes(specifier.text)
          ? runtime
          : githubSpecifiers.includes(specifier.text)
            ? github
            : undefined
        : undefined;
    if (specifier && target !== undefined)
      edits.push({
        start: specifier.getStart(source),
        end: specifier.end,
        text: JSON.stringify(target),
      });
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const edit of edits.reverse())
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}
async function patternSources() {
  const directory = join(repository, 'examples/patterns');
  const entries = z
    .array(
      z
        .object({
          id: z.string().regex(/^pattern-[a-z0-9-]+$/u),
          file: z.string().regex(/^[a-z0-9-]+(?:\.workflow)?\.ts$|^[a-z0-9-]+\.fixtures\.json$/u),
          kind: z.enum(['workflow', 'support', 'fixture']),
        })
        .strict(),
    )
    .parse(await json(join(directory, 'recipes.json')));
  const sources = new Map();
  for (const entry of entries) {
    requireThat(!sources.has(entry.id), `duplicate pattern example ${entry.id}`);
    const file = join(directory, entry.file);
    const code = (await readFile(file, 'utf8')).trimEnd();
    if (entry.kind === 'workflow')
      requireThat(
        entry.file.endsWith('.workflow.ts') && code.split('\n').length <= 30,
        `${file}: recipes must be complete workflows of at most 30 lines`,
      );
    sources.set(entry.id, { ...entry, file, code });
  }
  return sources;
}
export async function compileExamples(examples) {
  await mkdir(join(repository, '.context'), { recursive: true });
  const temporary = await mkdtemp(join(repository, '.context/skill-examples-'));
  try {
    const locations = new Map();
    for (const [index, example] of examples.entries()) {
      const file = example.sourceFile ?? join(temporary, `${index}.mts`);
      if (!example.sourceFile) await writeFile(file, sourceExample(example.code));
      locations.set(file, example);
    }
    const configFile = ts.readConfigFile(join(repository, 'tsconfig.json'), ts.sys.readFile);
    if (configFile.error)
      throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repository);
    const program = ts.createProgram([...locations.keys()], { ...parsed.options, noEmit: true });
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    requireThat(
      !diagnostics.length,
      diagnostics
        .map((diagnostic) => {
          const location = diagnostic.file && locations.get(diagnostic.file.fileName);
          const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
          const file = location?.file ?? diagnostic.file?.fileName ?? 'compiler';
          const line = (position?.line ?? 0) + (location?.line ?? 1);
          return `${file}:${line}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
        })
        .join('\n'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function checkSkills(root = repository, { compile = true } = {}) {
  for (const pkg of packages) {
    let path = root;
    for (const segment of pkg.split('/')) {
      path = join(path, segment);
      requireThat(
        !(await lstat(path)).isSymbolicLink(),
        `${path}: packages must be physical, not symlinks`,
      );
    }
  }
  await manifests(root);
  const allowlist = z
    .array(
      z
        .object({
          file: z.string().min(1),
          region: z.string().regex(/^[a-z0-9-]+$/u),
          reason: z.string().trim().min(1),
        })
        .strict(),
    )
    .parse(await json(join(root, 'plugins/skill-differences.json')));
  const rules = new Set(allowlist.map(({ file, region }) => `${file}:${region}`));
  requireThat(rules.size === allowlist.length, 'duplicate difference allowlist rule');
  const sources = await patternSources();
  const trees = [],
    examples = [];
  let links = 0,
    fragments = 0,
    commands = 0;
  for (const pkg of packages) {
    const packageRoot = join(root, pkg),
      skillRoot = join(packageRoot, skillPath);
    await files(packageRoot);
    const tree = new Map(),
      seen = new Set(),
      patternsSeen = new Set();
    for (const file of await files(skillRoot)) {
      const absolute = join(skillRoot, file);
      requireThat(inside(skillRoot, absolute), `invalid skill file ${file}`);
      if (!file.endsWith('.md')) {
        tree.set(file, (await readFile(absolute)).toString('base64'));
        continue;
      }
      const text = await readFile(absolute, 'utf8');
      if (file === 'SKILL.md') {
        frontmatter(text, absolute);
        checkPreExecution(text, absolute);
      }
      links += await checkLinks(absolute, text, packageRoot);
      if (file === 'references/patterns.md') checkPatternsIndex(text, absolute);
      tree.set(file, normalizeDifferences(text, file, rules, seen));
      for (const fence of fences(text, absolute)) {
        checkShellFence(fence, absolute);
        const source = sources.get(fence.id);
        if (fence.id?.startsWith('pattern-'))
          requireThat(source, `${absolute}: unknown pattern example ${fence.id}`);
        if (source) {
          requireThat(
            !patternsSeen.has(fence.id),
            `${absolute}: duplicate pattern example ${fence.id}`,
          );
          patternsSeen.add(fence.id);
          requireThat(
            fence.code === source.code,
            `${absolute}:${fence.line}: pattern example ${fence.id} differs from ${source.file}`,
          );
          requireThat(
            source.kind === 'fixture'
              ? fence.language === 'json'
              : ['ts', 'typescript'].includes(fence.language),
            `${absolute}: incorrect pattern example language`,
          );
        }
        if (!['ts', 'typescript'].includes(fence.language)) continue;
        if (fence.fragment) {
          fragments++;
          continue;
        }
        examples.push({ ...fence, file: absolute, ...(source ? { sourceFile: source.file } : {}) });
      }
    }
    const commandsRoot = join(packageRoot, 'commands');
    const hasCommands = await lstat(commandsRoot).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    for (const file of hasCommands ? await files(commandsRoot) : []) {
      const absolute = join(commandsRoot, file);
      requireThat(file.endsWith('.md'), `${absolute}: commands must be Markdown files`);
      const text = await readFile(absolute, 'utf8');
      commandFrontmatter(text, absolute);
      checkPreExecution(text, absolute);
      links += await checkLinks(absolute, text, packageRoot);
      commands++;
      for (const fence of fences(text, absolute)) {
        checkShellFence(fence, absolute);
        if (shellLanguages.has(fence.language))
          fence.code.split('\n').forEach((line, offset) => {
            requireThat(
              !commandSubstitution.test(line),
              `${absolute}:${String(fence.line + offset)}: command fence uses $ARGUMENTS or a positional $N, which Claude Code substitutes before the shell runs; use exported QC_* variables`,
            );
          });
        if (!['ts', 'typescript'].includes(fence.language)) continue;
        if (fence.fragment) {
          fragments++;
          continue;
        }
        examples.push({ ...fence, file: absolute });
      }
    }
    for (const id of sources.keys())
      requireThat(patternsSeen.has(id), `${pkg}: missing pattern example ${id}`);
    for (const rule of rules)
      requireThat(seen.has(rule), `${pkg}: unused difference allowlist rule ${rule}`);
    trees.push(tree);
  }
  requireThat(
    JSON.stringify([...trees[0].keys()]) === JSON.stringify([...trees[1].keys()]),
    'unlisted difference: skill file lists differ',
  );
  for (const [file, text] of trees[0])
    requireThat(text === trees[1].get(file), `unlisted difference: ${file}`);
  if (compile) await compileExamples(examples);
  return { packages: packages.length, commands, examples: examples.length, fragments, links };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(`Skills valid: ${JSON.stringify(await checkSkills())}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
