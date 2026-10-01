import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexHomeOf,
  codexInstructionWarning,
  detectCodexInstructionSources,
} from '../src/harnesses/codex-instructions.js';

let root: string;
let codexHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-codex-instructions-'));
  codexHome = join(root, 'codex-home');
  await mkdir(codexHome);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}
const detect = (cwd: string, signal?: AbortSignal) =>
  detectCodexInstructionSources({ codexHome, cwd, signal });
const names = (found: Awaited<ReturnType<typeof detect>>): string[] =>
  found.sources.map((source) =>
    `${source.scope}:${source.kind}:${source.path.slice(root.length + 1)}`.replaceAll('\\', '/'),
  );

describe('project discovery', () => {
  it('reads only cwd when no ancestor has a .git entry', async () => {
    await put(join(root, 'AGENTS.md'), 'above');
    await put(join(root, 'work', 'AGENTS.md'), 'parent');
    await put(join(root, 'work', 'leaf', 'AGENTS.md'), 'leaf');
    expect(names(await detect(join(root, 'work', 'leaf')))).toEqual([
      'project:agents:work/leaf/AGENTS.md',
    ]);
  });

  it.each([
    ['directory', async (path: string) => mkdir(path)],
    ['file', async (path: string) => writeFile(path, 'gitdir: ../elsewhere')],
  ])('walks from a .git %s down to cwd and ignores parents above it', async (_kind, marker) => {
    await put(join(root, 'AGENTS.md'), 'above the repository');
    await mkdir(join(root, 'repo', 'pkg', 'leaf'), { recursive: true });
    await marker(join(root, 'repo', '.git'));
    await put(join(root, 'repo', 'AGENTS.md'), 'root');
    await put(join(root, 'repo', 'pkg', 'AGENTS.md'), 'pkg');
    await put(join(root, 'repo', 'pkg', 'leaf', 'AGENTS.md'), 'leaf');
    // A sibling is never on the path from the root to cwd.
    await put(join(root, 'repo', 'other', 'AGENTS.md'), 'sibling');
    expect(names(await detect(join(root, 'repo', 'pkg', 'leaf')))).toEqual([
      'project:agents:repo/AGENTS.md',
      'project:agents:repo/pkg/AGENTS.md',
      'project:agents:repo/pkg/leaf/AGENTS.md',
    ]);
  });

  it('uses the nearest .git entry when repositories nest', async () => {
    await mkdir(join(root, 'outer', '.git'), { recursive: true });
    await mkdir(join(root, 'outer', 'inner', '.git'), { recursive: true });
    await put(join(root, 'outer', 'AGENTS.md'), 'outer');
    await put(join(root, 'outer', 'inner', 'AGENTS.md'), 'inner');
    expect(names(await detect(join(root, 'outer', 'inner')))).toEqual([
      'project:agents:outer/inner/AGENTS.md',
    ]);
  });

  it('lets AGENTS.override.md replace AGENTS.md in the same directory only', async () => {
    await mkdir(join(root, 'repo', 'pkg'), { recursive: true });
    await mkdir(join(root, 'repo', '.git'));
    await put(join(root, 'repo', 'AGENTS.md'), 'root');
    await put(join(root, 'repo', 'AGENTS.override.md'), 'root override');
    await put(join(root, 'repo', 'pkg', 'AGENTS.md'), 'pkg');
    expect(names(await detect(join(root, 'repo', 'pkg')))).toEqual([
      'project:agents-override:repo/AGENTS.override.md',
      'project:agents:repo/pkg/AGENTS.md',
    ]);
  });

  it('reports nothing for a directory without instruction files', async () => {
    expect(await detect(root)).toEqual({ sources: [], omittedSkills: 0, warnings: [] });
  });
});

describe('user discovery', () => {
  it('reads CODEX_HOME/AGENTS.md and prefers AGENTS.override.md', async () => {
    await put(join(codexHome, 'AGENTS.md'), 'plain');
    expect(names(await detect(root))).toEqual(['user:agents:codex-home/AGENTS.md']);
    await put(join(codexHome, 'AGENTS.override.md'), 'override');
    expect(names(await detect(root))).toEqual([
      'user:agents-override:codex-home/AGENTS.override.md',
    ]);
  });

  it('ignores an empty user-level override but honors an empty project-level one', async () => {
    await put(join(codexHome, 'AGENTS.md'), 'plain');
    await put(join(codexHome, 'AGENTS.override.md'), '');
    await put(join(root, 'AGENTS.md'), 'project plain');
    await put(join(root, 'AGENTS.override.md'), '');
    expect(names(await detect(root))).toEqual([
      'user:agents:codex-home/AGENTS.md',
      'project:agents-override:AGENTS.override.md',
    ]);
  });

  it('returns no sources for a missing CODEX_HOME', async () => {
    const found = await detectCodexInstructionSources({
      codexHome: join(root, 'absent'),
      cwd: root,
    });
    expect(found).toEqual({ sources: [], omittedSkills: 0, warnings: [] });
  });

  it('lists user skills but skips dot-directories such as skills/.system', async () => {
    await put(join(codexHome, 'skills', '.system', 'bundled', 'SKILL.md'), 'bundled');
    await put(join(codexHome, 'skills', '.system', 'SKILL.md'), 'bundled root');
    await put(join(codexHome, 'skills', 'beta', 'SKILL.md'), 'b');
    await put(join(codexHome, 'skills', 'alpha', 'SKILL.md'), 'a');
    await mkdir(join(codexHome, 'skills', 'empty'));
    await put(join(codexHome, 'skills', 'loose.md'), 'not a skill directory');
    expect(names(await detect(root))).toEqual([
      'user:skill:codex-home/skills/alpha/SKILL.md',
      'user:skill:codex-home/skills/beta/SKILL.md',
    ]);
  });

  it('caps the skill listing and counts the rest', async () => {
    for (let index = 0; index < 66; index += 1)
      await put(join(codexHome, 'skills', `s${String(index).padStart(3, '0')}`, 'SKILL.md'), 'x');
    const found = await detect(root);
    expect(found.sources.filter((source) => source.kind === 'skill')).toHaveLength(64);
    expect(found.omittedSkills).toBe(2);
    expect(codexInstructionWarning(found)).toContain('66 skill description files');
  });

  it('resolves CODEX_HOME from the child environment, then HOME', () => {
    expect(codexHomeOf({ CODEX_HOME: '/a/b', HOME: '/h' })).toBe('/a/b');
    expect(codexHomeOf({ CODEX_HOME: '', HOME: '/h' })).toBe(join('/h', '.codex'));
    expect(codexHomeOf({})).toMatch(/\.codex$/u);
  });
});

describe('digests and diagnostics', () => {
  it('hashes file bytes and never returns contents', async () => {
    const secret = 'CANARY-CONTENT-8841 '.repeat(1000);
    await put(join(codexHome, 'AGENTS.md'), secret);
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await put(join(root, 'repo', 'AGENTS.md'), secret + 'project');
    const found = await detect(join(root, 'repo'));
    expect(found.sources).toEqual([
      { scope: 'user', kind: 'agents', path: join(codexHome, 'AGENTS.md'), sha256: sha(secret) },
      {
        scope: 'project',
        kind: 'agents',
        path: join(root, 'repo', 'AGENTS.md'),
        sha256: sha(secret + 'project'),
      },
    ]);
    expect(JSON.stringify(found)).not.toContain('CANARY-CONTENT');
    expect(JSON.stringify(codexInstructionWarning(found))).not.toContain('CANARY-CONTENT');
  });

  it('warns only about user-level sources and names the file', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await put(join(root, 'repo', 'AGENTS.md'), 'project only');
    expect(codexInstructionWarning(await detect(join(root, 'repo')))).toBeUndefined();
    await put(join(codexHome, 'AGENTS.md'), 'user');
    const warning = codexInstructionWarning(await detect(join(root, 'repo')));
    expect(warning).toContain(join(codexHome, 'AGENTS.md'));
    expect(warning).toContain(sha('user').slice(0, 12));
    expect(warning).toContain('every isolation mode, including restricted');
    expect(warning).not.toContain(join(root, 'repo', 'AGENTS.md'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'turns an unreadable file into a warning instead of throwing',
    async () => {
      const file = join(codexHome, 'AGENTS.md');
      await put(file, 'secret');
      await chmod(file, 0o000);
      const found = await detect(root);
      expect(found.sources).toEqual([]);
      expect(found.warnings).toEqual([expect.stringContaining(file)]);
    },
  );

  it('ignores a directory named AGENTS.md and follows a symlinked file', async () => {
    await mkdir(join(codexHome, 'AGENTS.md'));
    expect((await detect(root)).sources).toEqual([]);
    await rm(join(codexHome, 'AGENTS.md'), { recursive: true });
    await put(join(root, 'real.md'), 'linked');
    await symlink(join(root, 'real.md'), join(codexHome, 'AGENTS.md'));
    expect((await detect(root)).sources).toEqual([
      expect.objectContaining({ kind: 'agents', sha256: sha('linked') }),
    ]);
  });

  it('rejects on an aborted signal rather than reporting a partial result', async () => {
    await put(join(codexHome, 'AGENTS.md'), 'x');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(detect(root, controller.signal)).rejects.toThrow('stop');
  });
});
