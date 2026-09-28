import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { checkLinks, fences, inside } from './skill-markdown.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const packages = ['agents', 'claude'].map((host) => `plugins/${host}/quiet-choir`);
const skillPath = 'skills/quiet-choir';
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
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
async function manifests(root) {
  const portableFile = join(root, packages[0], 'plugin.json');
  const portable = await json(portableFile);
  const schema = await json(join(repository, 'test/fixtures/skills/agent-plugin.schema.json'));
  const result = z.fromJSONSchema(schema).safeParse(portable);
  requireThat(result.success, `${portableFile}: invalid manifest: ${result.error?.message ?? ''}`);
  // This repository distributes documentation-only Claude plugins. Expanding its surface requires
  // extending this explicit schema; unknown component fields must not silently bypass validation.
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
  for (const key of Object.keys(common))
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
/** Replace import specifiers only; prompt strings and executable code stay intact. */
export function sourceExample(code, runtime = join(repository, 'src/index.js')) {
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
    if (
      specifier &&
      ts.isStringLiteral(specifier) &&
      ['quiet-choir', '../src/index.js', '/absolute/path/to/quiet-choir/dist/index.js'].includes(
        specifier.text,
      )
    )
      edits.push({
        start: specifier.getStart(source),
        end: specifier.end,
        text: JSON.stringify(runtime),
      });
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const edit of edits.reverse())
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}
export async function compileExamples(examples) {
  await mkdir(join(repository, '.context'), { recursive: true });
  const temporary = await mkdtemp(join(repository, '.context/skill-examples-'));
  try {
    const locations = new Map();
    for (const [index, example] of examples.entries()) {
      const file = join(temporary, `${index}.mts`);
      await writeFile(file, sourceExample(example.code));
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
  const trees = [],
    examples = [];
  let links = 0,
    fragments = 0;
  for (const pkg of packages) {
    const packageRoot = join(root, pkg),
      skillRoot = join(packageRoot, skillPath);
    await files(packageRoot);
    const tree = new Map(),
      seen = new Set();
    for (const file of await files(skillRoot)) {
      const absolute = join(skillRoot, file);
      requireThat(inside(skillRoot, absolute), `invalid skill file ${file}`);
      if (!file.endsWith('.md')) {
        tree.set(file, (await readFile(absolute)).toString('base64'));
        continue;
      }
      const text = await readFile(absolute, 'utf8');
      if (file === 'SKILL.md') frontmatter(text, absolute);
      links += await checkLinks(absolute, text, packageRoot);
      tree.set(file, normalizeDifferences(text, file, rules, seen));
      for (const fence of fences(text, absolute)) {
        if (!['ts', 'typescript'].includes(fence.language)) continue;
        if (fence.fragment) {
          fragments++;
          continue;
        }
        examples.push({ ...fence, file: absolute });
      }
    }
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
  return { packages: packages.length, examples: examples.length, fragments, links };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(`Skills valid: ${JSON.stringify(await checkSkills())}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
