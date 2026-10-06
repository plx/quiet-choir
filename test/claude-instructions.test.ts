import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeConfigDirOf,
  detectClaudeUserInstructionSources,
} from '../src/harnesses/claude-instructions.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-claude-instructions-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

// Measured on Claude Code 2.1.290 by the contract case claude-user-instructions (#227).
describe('Claude configuration directory', () => {
  it('prefers CLAUDE_CONFIG_DIR over HOME/.claude', () => {
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/config', HOME: '/h' })).toBe('/config');
    expect(claudeConfigDirOf({ HOME: '/h' })).toBe(join('/h', '.claude'));
  });

  it('treats empty values as unset', () => {
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '', HOME: '/h' })).toBe(join('/h', '.claude'));
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '', HOME: '' })).toBe(join(homedir(), '.claude'));
  });
});

describe('user CLAUDE.md detection', () => {
  it('records the file as a user claude-md source by path and digest only', async () => {
    const configDir = join(root, 'config');
    await mkdir(configDir);
    await writeFile(join(configDir, 'CLAUDE.md'), 'SECRET-CLAUDE-CANARY @imported.md');
    const found = await detectClaudeUserInstructionSources({ configDir, cwd: root });
    expect(found).toEqual({
      sources: [
        {
          scope: 'user',
          kind: 'claude-md',
          path: join(configDir, 'CLAUDE.md'),
          sha256: sha('SECRET-CLAUDE-CANARY @imported.md'),
        },
      ],
      warnings: [],
    });
    expect(JSON.stringify(found)).not.toContain('SECRET-CLAUDE-CANARY');
  });

  it('records a blank file, erring toward recording', async () => {
    await writeFile(join(root, 'CLAUDE.md'), ' \n');
    const found = await detectClaudeUserInstructionSources({ configDir: root, cwd: root });
    expect(found.sources).toEqual([expect.objectContaining({ sha256: sha(' \n') })]);
  });

  it('resolves a relative configuration directory against cwd', async () => {
    await mkdir(join(root, 'work', 'conf'), { recursive: true });
    await writeFile(join(root, 'work', 'conf', 'CLAUDE.md'), 'x');
    const found = await detectClaudeUserInstructionSources({
      configDir: 'conf',
      cwd: join(root, 'work'),
    });
    expect(found.sources.map((source) => source.path)).toEqual([
      join(root, 'work', 'conf', 'CLAUDE.md'),
    ]);
  });

  it('reports nothing when the file or directory is absent', async () => {
    expect(
      await detectClaudeUserInstructionSources({ configDir: join(root, 'absent'), cwd: root }),
    ).toEqual({ sources: [], warnings: [] });
    await mkdir(join(root, 'CLAUDE.md'));
    expect(
      (await detectClaudeUserInstructionSources({ configDir: root, cwd: root })).sources,
    ).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'turns an unreadable file into a warning instead of throwing',
    async () => {
      const file = join(root, 'CLAUDE.md');
      await writeFile(file, 'secret');
      await chmod(file, 0o000);
      const found = await detectClaudeUserInstructionSources({ configDir: root, cwd: root });
      expect(found.sources).toEqual([]);
      expect(found.warnings).toEqual([
        expect.stringMatching(/^Could not inspect Claude instruction file .*CLAUDE\.md: /u),
      ]);
    },
  );

  it('also records HOME/.claude/CLAUDE.md when CLAUDE_CONFIG_DIR is set and HOME is an ancestor of cwd', async () => {
    const home = join(root, 'home');
    const configDir = join(root, 'config');
    const cwd = join(home, 'work', 'repo');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(configDir);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(configDir, 'CLAUDE.md'), 'configured');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'ancestor');
    const found = await detectClaudeUserInstructionSources({ configDir, cwd, home });
    expect(found.sources).toEqual([
      {
        scope: 'user',
        kind: 'claude-md',
        path: join(configDir, 'CLAUDE.md'),
        sha256: sha('configured'),
      },
      {
        scope: 'user',
        kind: 'claude-md',
        path: join(home, '.claude', 'CLAUDE.md'),
        sha256: sha('ancestor'),
      },
    ]);
    // HOME itself counts as an ancestor.
    expect(
      (await detectClaudeUserInstructionSources({ configDir, cwd: home, home })).sources,
    ).toHaveLength(2);
  });

  it('records only the configured file when cwd is outside HOME', async () => {
    const home = join(root, 'home');
    const configDir = join(root, 'config');
    // A sibling whose name starts with the home directory's name is not inside it.
    const cwd = join(root, 'home-other');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(configDir);
    await mkdir(cwd);
    await writeFile(join(configDir, 'CLAUDE.md'), 'configured');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'ancestor');
    const found = await detectClaudeUserInstructionSources({ configDir, cwd, home });
    expect(found.sources.map((source) => source.path)).toEqual([join(configDir, 'CLAUDE.md')]);
  });

  it('records HOME/.claude/CLAUDE.md once when it is the configuration directory', async () => {
    const home = join(root, 'home');
    const cwd = join(home, 'repo');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(cwd);
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'x');
    const found = await detectClaudeUserInstructionSources({
      configDir: claudeConfigDirOf({ HOME: home }),
      cwd,
      home,
    });
    expect(found.sources.map((source) => source.path)).toEqual([
      join(home, '.claude', 'CLAUDE.md'),
    ]);
  });

  it('rejects on an aborted signal', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'x');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      detectClaudeUserInstructionSources({ configDir: root, cwd: root, signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});
