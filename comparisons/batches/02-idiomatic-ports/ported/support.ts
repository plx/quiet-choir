import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z, type AgentProfile, type WorkflowContext, type JsonValue } from 'quiet-choir';

export const profiles = {
  reader: {
    extends: 'readonly',
    claude: { tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'] },
    codex: { sandbox: 'read-only' },
    maxTurns: 20,
    maxBudgetUsd: 2,
    timeoutMs: 300_000,
  },
  writer: {
    extends: 'edit',
    claude: {
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
    },
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 600_000,
  },
} satisfies Record<string, AgentProfile>;

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2);
// Checkpoint transport may reorder object keys; array order remains semantic.
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

// Git output must be complete: a silently truncated manifest cannot prove coverage.
export async function git(ctx: WorkflowContext, id: string, args: [string, ...string[]]) {
  const result = await ctx.exec(id, ['git', ...args]);
  if (result.truncated) throw new Error(`Incomplete Git output: ${id}`);
  return result.stdout;
}

export async function gitWindow(ctx: WorkflowContext, since: string, until: string) {
  const start = Sha.parse(
    (
      await git(ctx, 'since', ['rev-parse', '--verify', '--end-of-options', `${since}^{commit}`])
    ).trim(),
  );
  const end = Sha.parse(
    (
      await git(ctx, 'until', ['rev-parse', '--verify', '--end-of-options', `${until}^{commit}`])
    ).trim(),
  );
  const manifest = z
    .array(Sha)
    .parse(
      (await git(ctx, 'manifest', ['rev-list', '--reverse', `${start}..${end}`, '--']))
        .trim()
        .split('\n')
        .filter(Boolean),
    );
  return { start, end, manifest };
}

export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}

// Publication through a managed checkout keeps later lifecycle writers on committed artifacts.
export async function writeCommittedArtifact(ctx: WorkflowContext, out: string, content: string) {
  Path.parse(out);
  const tree = await ctx.worktree('document');
  await ctx.step('write', {
    input: { out, content },
    worktree: tree,
    schema: z.null(),
    async run({ cwd }) {
      const root = await realpath(cwd);
      let parent = root;
      for (const part of out.split('/').slice(0, -1)) {
        parent = resolve(parent, part);
        try {
          await mkdir(parent);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        const actual = relative(root, await realpath(parent));
        const escaped = actual === '..' || actual.startsWith('..' + sep);
        if (escaped || isAbsolute(actual)) throw new Error('Artifact parent escapes checkout');
      }
      await writeFile(resolve(root, out), content, { flag: 'wx' });
      return null;
    },
  });
  await ctx.merge('publish', [tree], { target: 'checkout', onConflict: 'fail' });
  return {
    path: resolve(ctx.cwd, out),
    sha256: digest(content),
    bytes: Buffer.byteLength(content),
    previousSha256: null,
  };
}
