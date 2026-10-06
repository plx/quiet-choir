import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexHomeOf,
  codexInstructionWarning,
  detectCodexInstructionSources,
  detectCodexProjectInstructionSources,
  detectCodexUserInstructionSources,
} from '../src/harnesses/codex-instructions.js';
import { userHomeOf } from '../src/harnesses/instruction-files.js';

let root: string;
let codexHome: string;
// The child's HOME, kept inside the temporary root so the real ~/.agents/skills never leaks in.
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-codex-instructions-'));
  codexHome = join(root, 'codex-home');
  home = join(root, 'home');
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
  detectCodexInstructionSources({ codexHome, home, cwd, signal });
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

  it('falls back to AGENTS.md when the user-level override is whitespace-only', async () => {
    await put(join(codexHome, 'AGENTS.md'), 'plain');
    await put(join(codexHome, 'AGENTS.override.md'), ' \n\t\r\n ');
    expect(names(await detect(root))).toEqual(['user:agents:codex-home/AGENTS.md']);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \n\t\n   \r\n'],
  ])('does not record a %s user-level AGENTS.md or warn about it', async (_name, blank) => {
    await put(join(codexHome, 'AGENTS.md'), blank);
    const found = await detect(root);
    expect(names(found)).toEqual([]);
    expect(codexInstructionWarning(found)).toBeUndefined();
    await put(join(codexHome, 'AGENTS.override.md'), '\n  ');
    const both = await detect(root);
    expect(names(both)).toEqual([]);
    expect(codexInstructionWarning(both)).toBeUndefined();
  });

  it('still lets a whitespace-only project override replace AGENTS.md', async () => {
    await put(join(root, 'AGENTS.md'), 'project plain');
    await put(join(root, 'AGENTS.override.md'), ' \n\t ');
    expect(names(await detect(root))).toEqual(['project:agents-override:AGENTS.override.md']);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t\r\n '],
  ])(
    'does not record a %s project AGENTS.md but lists deeper non-blank ones',
    async (_n, blank) => {
      await mkdir(join(root, 'repo', 'pkg'), { recursive: true });
      await mkdir(join(root, 'repo', '.git'));
      await put(join(root, 'repo', 'AGENTS.md'), blank);
      await put(join(root, 'repo', 'pkg', 'AGENTS.md'), 'pkg');
      expect(names(await detect(join(root, 'repo', 'pkg')))).toEqual([
        'project:agents:repo/pkg/AGENTS.md',
      ]);
    },
  );

  it('counts content padded with blank lines and hashes the raw bytes', async () => {
    const padded = '\n\n  \t instructions \r\n\n';
    await put(join(codexHome, 'AGENTS.md'), padded);
    expect((await detect(root)).sources).toEqual([
      { scope: 'user', kind: 'agents', path: join(codexHome, 'AGENTS.md'), sha256: sha(padded) },
    ]);
  });

  it('counts content that follows a long blank run beyond one read chunk', async () => {
    const padded = `${' '.repeat(200_000)}x`;
    await put(join(codexHome, 'AGENTS.md'), padded);
    expect((await detect(root)).sources).toEqual([
      expect.objectContaining({ kind: 'agents', sha256: sha(padded) }),
    ]);
  });

  it('treats Unicode White_Space-only content as blank but a lone BOM as content', async () => {
    await put(join(codexHome, 'AGENTS.md'), '\u3000 \u00a0\u2003\n');
    expect(names(await detect(root))).toEqual([]);
    await put(join(codexHome, 'AGENTS.md'), '\ufeff');
    expect(names(await detect(root))).toEqual(['user:agents:codex-home/AGENTS.md']);
  });

  it('returns no sources for a missing CODEX_HOME', async () => {
    const found = await detectCodexInstructionSources({
      codexHome: join(root, 'absent'),
      home,
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

describe('separate user and project detection', () => {
  async function layout(): Promise<string> {
    await put(join(codexHome, 'AGENTS.md'), 'user');
    await put(join(codexHome, 'skills', 'review', 'SKILL.md'), 'skill');
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await put(join(root, 'repo', 'AGENTS.md'), 'root');
    await put(join(root, 'repo', 'pkg', 'AGENTS.override.md'), '  \n');
    await put(join(root, 'repo', 'pkg', 'AGENTS.md'), 'replaced');
    await put(join(root, 'repo', 'pkg', 'leaf', 'AGENTS.md'), ' \t\n');
    return join(root, 'repo', 'pkg', 'leaf');
  }

  it('finds only project files from the Git root down to cwd, never reading CODEX_HOME', async () => {
    const cwd = await layout();
    // A CODEX_HOME inside cwd would be found by a user-level read; the project walk ignores it.
    await put(join(cwd, '.codex', 'AGENTS.md'), 'user-looking');
    const found = await detectCodexProjectInstructionSources({ cwd, home });
    expect(names({ ...found, omittedSkills: 0 })).toEqual([
      'project:agents:repo/AGENTS.md',
      // A blank project override still replaces AGENTS.md; a blank AGENTS.md is skipped.
      'project:agents-override:repo/pkg/AGENTS.override.md',
    ]);
    expect(found.warnings).toEqual([]);
    expect(found).not.toHaveProperty('omittedSkills');
  });

  it('finds only user files and skills, whatever cwd holds', async () => {
    const cwd = await layout();
    const found = await detectCodexUserInstructionSources({ codexHome, home, cwd });
    expect(names(found)).toEqual([
      'user:agents:codex-home/AGENTS.md',
      'user:skill:codex-home/skills/review/SKILL.md',
    ]);
    expect(found.omittedSkills).toBe(0);
  });

  it('keeps the combined detection as user sources followed by project sources', async () => {
    const cwd = await layout();
    const user = await detectCodexUserInstructionSources({ codexHome, home, cwd });
    const project = await detectCodexProjectInstructionSources({ cwd, home });
    expect(await detect(cwd)).toEqual({
      sources: [...user.sources, ...project.sources],
      omittedSkills: 0,
      warnings: [],
    });
  });

  it('rejects project detection on an aborted signal', async () => {
    const cwd = await layout();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      detectCodexProjectInstructionSources({ cwd, home, signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});

// Rules measured on codex-cli 0.160.0 by the contract cases codex-restricted-skill-layout,
// codex-restricted-skill-no-git and codex-restricted (#227).
describe('skill roots', () => {
  const skill = (directory: string, text = 'skill') => put(join(directory, 'SKILL.md'), text);

  it('lists .agents/skills from the Git root down to cwd after each AGENTS file, and .codex/skills in cwd only', async () => {
    const repo = join(root, 'repo');
    const leaf = join(repo, 'pkg', 'leaf');
    await mkdir(join(repo, '.git'), { recursive: true });
    await skill(join(root, '.agents', 'skills', 'above'));
    await put(join(repo, 'AGENTS.md'), 'root');
    await skill(join(repo, '.agents', 'skills', 'a'));
    await skill(join(repo, '.codex', 'skills', 'not-cwd'));
    await skill(join(repo, 'pkg', '.agents', 'skills', 'b'));
    await put(join(leaf, 'AGENTS.md'), 'leaf');
    await skill(join(leaf, '.agents', 'skills', 'c'));
    await skill(join(leaf, '.codex', 'skills', 'd'));
    const found = await detectCodexProjectInstructionSources({ cwd: leaf, home });
    expect(names({ ...found, omittedSkills: 0 })).toEqual([
      'project:agents:repo/AGENTS.md',
      'project:skill:repo/.agents/skills/a/SKILL.md',
      'project:skill:repo/pkg/.agents/skills/b/SKILL.md',
      'project:agents:repo/pkg/leaf/AGENTS.md',
      'project:skill:repo/pkg/leaf/.agents/skills/c/SKILL.md',
      'project:skill:repo/pkg/leaf/.codex/skills/d/SKILL.md',
    ]);
    expect(found.sources[1]?.sha256).toBe(sha('skill'));
    expect(found.warnings).toEqual([]);
  });

  it('reads only the cwd skill roots when no ancestor has a .git entry', async () => {
    await skill(join(root, 'work', '.agents', 'skills', 'parent'));
    await skill(join(root, 'work', 'leaf', '.agents', 'skills', 'cwd'));
    expect(names(await detect(join(root, 'work', 'leaf')))).toEqual([
      'project:skill:work/leaf/.agents/skills/cwd/SKILL.md',
    ]);
  });

  it('searches six levels deep, skips dot names and keeps searching inside a skill', async () => {
    const skills = join(root, 'work', '.agents', 'skills');
    await skill(join(skills, '.hidden'));
    await skill(join(skills, 'group', '.cache', 'tool'));
    await skill(join(skills, 'group', 'deep'));
    await skill(join(skills, 'outer'));
    await skill(join(skills, 'outer', 'inner'));
    await skill(join(skills, 'g6', 'a', 'b', 'c', 'd', 'depth6'));
    await skill(join(skills, 'g7', 'a', 'b', 'c', 'd', 'e', 'depth7'));
    await put(join(skills, 'loose.md'), 'not a skill directory');
    expect(names(await detect(join(root, 'work')))).toEqual([
      'project:skill:work/.agents/skills/g6/a/b/c/d/depth6/SKILL.md',
      'project:skill:work/.agents/skills/group/deep/SKILL.md',
      'project:skill:work/.agents/skills/outer/SKILL.md',
      'project:skill:work/.agents/skills/outer/inner/SKILL.md',
    ]);
  });

  it('stops a skill listing after 2000 directories with a warning', async () => {
    const skills = join(root, 'work', '.agents', 'skills');
    for (let index = 0; index < 2000; index += 1)
      await mkdir(join(skills, `d${String(index).padStart(4, '0')}`), { recursive: true });
    await skill(join(skills, 'z-late'));
    const found = await detectCodexProjectInstructionSources({ cwd: join(root, 'work'), home });
    expect(found.sources).toEqual([]);
    expect(found.warnings).toEqual([
      `Stopped listing Codex skills under ${skills} after 2000 directories; more skill files may load.`,
    ]);
  });

  it('lists nested CODEX_HOME skills as user skills', async () => {
    await skill(join(codexHome, 'skills', 'group', 'nested'));
    expect(names(await detect(root))).toEqual([
      'user:skill:codex-home/skills/group/nested/SKILL.md',
    ]);
  });

  it('warns with the count when project skills exceed the cap', async () => {
    const cwd = join(root, 'work');
    for (let index = 0; index < 66; index += 1)
      await skill(join(cwd, '.agents', 'skills', `s${String(index).padStart(3, '0')}`));
    const found = await detectCodexProjectInstructionSources({ cwd, home });
    expect(found.sources).toHaveLength(64);
    expect(found.warnings).toEqual([
      `Codex loads 2 more project skill files for ${cwd} than the 64 recorded.`,
    ]);
  });

  it('lists $HOME/.agents/skills as user skills, counted in the warning', async () => {
    await skill(join(home, '.agents', 'skills', 'personal'), 'mine');
    const found = await detect(join(root, 'work'));
    expect(found.sources).toEqual([
      {
        scope: 'user',
        kind: 'skill',
        path: join(home, '.agents', 'skills', 'personal', 'SKILL.md'),
        sha256: sha('mine'),
      },
    ]);
    const warning = codexInstructionWarning(found);
    expect(warning).toContain('1 skill description file');
    expect(warning).toContain('skills under $HOME/.agents/skills still load');
  });

  it('records HOME .agents skills once, as user skills, when HOME is on the project walk', async () => {
    await mkdir(join(home, '.git'), { recursive: true });
    await skill(join(home, '.agents', 'skills', 'personal'));
    await skill(join(home, 'repo', '.agents', 'skills', 'project'));
    expect(names(await detect(join(home, 'repo')))).toEqual([
      'user:skill:home/.agents/skills/personal/SKILL.md',
      'project:skill:home/repo/.agents/skills/project/SKILL.md',
    ]);
  });

  it('counts HOME skills beyond the cap shared with CODEX_HOME/skills', async () => {
    for (let index = 0; index < 64; index += 1)
      await skill(join(codexHome, 'skills', `s${String(index).padStart(3, '0')}`));
    await skill(join(home, '.agents', 'skills', 'personal'));
    const found = await detect(root);
    expect(found.omittedSkills).toBe(1);
    expect(codexInstructionWarning(found)).toContain('65 skill description files');
  });

  it('resolves HOME from the child environment, treating an empty value as unset', () => {
    expect(userHomeOf({ HOME: '/h' })).toBe('/h');
    expect(userHomeOf({ HOME: '' })).toBe(userInfo().homedir);
    expect(userHomeOf({})).toBe(userInfo().homedir);
  });

  it("falls back to the account home, not the parent's overridden HOME", () => {
    const original = process.env['HOME'];
    process.env['HOME'] = join(root, 'overridden-home');
    try {
      expect(userHomeOf({})).toBe(userInfo().homedir);
      expect(userHomeOf({ HOME: '' })).toBe(userInfo().homedir);
    } finally {
      if (original === undefined) delete process.env['HOME'];
      else process.env['HOME'] = original;
    }
  });

  it('does not detect CODEX_HOME memories, which load only with features.memories enabled', async () => {
    await put(join(codexHome, 'memories', 'memory_summary.md'), 'v1\nsummary');
    await put(join(codexHome, 'memories', 'MEMORY.md'), 'memory');
    expect(await detect(root)).toEqual({ sources: [], omittedSkills: 0, warnings: [] });
  });
});
