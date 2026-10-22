// GitHub mechanics that quiet-choir/github does not offer yet, as versioned steps over raw `gh api`
// (follow-ups #668 and #682): the epic checklist tick and insert, label writes,
// the sub-issue link, an issue read that tolerates a 404, the exact-title lookup before filing, and
// the local ledger. Each step reads before it writes, so a retry or resume after a crash finds the
// state the last attempt left and does nothing twice.
//
// GitHub has no conditional update for an issue body: the tick and the insert are check-then-act,
// and an edit made between the read and the PATCH is overwritten, as with `pr.edit`.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z, type JsonValue, type StepContext, type WorkflowContext } from 'quiet-choir';
import { parseGithubRepo } from 'quiet-choir/github';
import { run } from '../../merge-down.quiet-choir/lib/git.js';
import { BodyEdit } from '../contracts.js';
import { insertAfter, tickBody } from './policy.js';

const write = { retry: { maxAttempts: 3, on: ['process', 'timeout'] as const } };
const LABEL_COLOR = 'BFD4F2';
const LABEL_DESCRIPTION = 'Set by the execute-epic-ticket workflow';

/** Read an issue's body. */
async function readBody(context: StepContext, repo: string, number: number): Promise<string> {
  const issue = await context.exec.json(
    ['gh', 'api', `repos/${repo}/issues/${String(number)}`, '--jq', '{body: .body}'],
    { schema: z.object({ body: z.string().nullable() }) },
  );
  return issue.body ?? '';
}

/** Replace an issue's body; the request goes to gh on stdin. */
async function patchBody(
  context: StepContext,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await context.exec(
    [
      'gh',
      'api',
      '-X',
      'PATCH',
      `repos/${repo}/issues/${String(number)}`,
      '--input',
      '-',
      '--silent',
    ],
    { input: JSON.stringify({ body }) },
  );
}

/** Edit an epic body with `edit`, PATCHing only when it changes. */
function editEpic(
  ctx: WorkflowContext,
  id: string,
  step: { readonly version: string; readonly input: Record<string, JsonValue> },
  epic: { readonly repo: string; readonly number: number },
  edit: (body: string) => string | null,
): Promise<{ changed: boolean }> {
  return ctx.step(id, {
    identity: 'version',
    version: step.version,
    input: step.input,
    schema: BodyEdit,
    ...write,
    async run(context) {
      const next = edit(await readBody(context, epic.repo, epic.number));
      if (next === null) return { changed: false };
      await patchBody(context, epic.repo, epic.number, next);
      return { changed: true };
    },
  });
}

/** Tick `- [ ] #ticket` in the epic's checklist; a ticked or unlisted ticket changes nothing. */
export function tick(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly epic: number; readonly ticket: number },
): Promise<{ changed: boolean }> {
  const epic = { repo: input.repo, number: input.epic };
  return editEpic(ctx, id, { version: 'epic-ticket.tick/1', input: { ...input } }, epic, (body) =>
    tickBody(body, input.ticket, input.repo),
  );
}

/** Insert `- [ ] #n title` lines for `entries` right after `#parent`'s line, skipping listed ones. */
export function insertChecklist(
  ctx: WorkflowContext,
  id: string,
  input: {
    readonly repo: string;
    readonly epic: number;
    readonly parent: number;
    readonly entries: readonly { readonly number: number; readonly title: string }[];
  },
): Promise<{ changed: boolean }> {
  const step = {
    version: 'epic-ticket.insert-checklist/1',
    input: { ...input, entries: input.entries.map((e) => ({ ...e })) },
  };
  const epic = { repo: input.repo, number: input.epic };
  return editEpic(ctx, id, step, epic, (body) =>
    insertAfter(body, input.parent, input.entries, input.repo),
  );
}

/** Whether a failed `gh api` call was a 404. */
const notFound = (result: { stdout: string; stderr: string }): boolean =>
  /HTTP 404|Not Found/i.test(result.stderr + result.stdout);

/** Create a label in the repository unless it exists. */
export function ensureLabel(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly label: string },
): Promise<{ created: boolean }> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.ensure-label/1',
    input: { ...input },
    schema: z.object({ created: z.boolean() }),
    ...write,
    async run(context) {
      const path = `repos/${input.repo}/labels/${encodeURIComponent(input.label)}`;
      const found = await run(context, ['gh', 'api', path, '--silent']);
      if (found.code === 0) return { created: false };
      if (!notFound(found)) throw new Error(`gh api ${path}: ${found.stderr.trim()}`);
      await context.exec([
        'gh',
        'api',
        '-X',
        'POST',
        `repos/${input.repo}/labels`,
        '-f',
        `name=${input.label}`,
        '-f',
        `color=${LABEL_COLOR}`,
        '-f',
        `description=${LABEL_DESCRIPTION}`,
        '--silent',
      ]);
      return { created: true };
    },
  });
}

/** An issue's label names. */
async function labelsOf(context: StepContext, repo: string, number: number): Promise<string[]> {
  const issue = await context.exec.json(
    ['gh', 'api', `repos/${repo}/issues/${String(number)}`, '--jq', '{labels: [.labels[].name]}'],
    { schema: z.object({ labels: z.array(z.string()) }) },
  );
  return issue.labels;
}

/** Add a label to an issue unless it has it. */
export function addLabel(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly number: number; readonly label: string },
): Promise<{ changed: boolean }> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.add-label/1',
    input: { ...input },
    schema: BodyEdit,
    ...write,
    async run(context) {
      if ((await labelsOf(context, input.repo, input.number)).includes(input.label))
        return { changed: false };
      await context.exec([
        'gh',
        'api',
        '-X',
        'POST',
        `repos/${input.repo}/issues/${String(input.number)}/labels`,
        '-f',
        `labels[]=${input.label}`,
        '--silent',
      ]);
      return { changed: true };
    },
  });
}

/** Remove a label from an issue; a label the issue does not have (a 404) is success. */
export function removeLabel(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly number: number; readonly label: string },
): Promise<{ changed: boolean }> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.remove-label/1',
    input: { ...input },
    schema: BodyEdit,
    ...write,
    async run(context) {
      if (!(await labelsOf(context, input.repo, input.number)).includes(input.label))
        return { changed: false };
      const path = `repos/${input.repo}/issues/${String(input.number)}/labels/${encodeURIComponent(input.label)}`;
      const removed = await run(context, ['gh', 'api', '-X', 'DELETE', path, '--silent']);
      if (removed.code === 0) return { changed: true };
      if (notFound(removed)) return { changed: false };
      throw new Error(`gh api -X DELETE ${path}: ${removed.stderr.trim()}`);
    },
  });
}

/** An issue's number, title and uppercased state; a pull request is not an issue. */
export const IssueState = z.object({
  number: z.int(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
});
export type IssueState = z.output<typeof IssueState>;

/** An issue's state, or null when the number does not exist (a 404) or is a pull request. */
export function issueState(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly number: number },
): Promise<IssueState | null> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.issue-state/1',
    input: { ...input },
    schema: IssueState.nullable(),
    ...write,
    async run(context) {
      const path = `repos/${input.repo}/issues/${String(input.number)}`;
      const read = await run(context, [
        'gh',
        'api',
        path,
        '--jq',
        '{number,title,state,pull_request}',
      ]);
      if (read.code !== 0) {
        if (notFound(read)) return null;
        throw new Error(`gh api ${path}: ${read.stderr.trim()}`);
      }
      const issue = z
        .object({
          number: z.int(),
          title: z.string(),
          state: z.string(),
          pull_request: z.unknown().optional(),
        })
        .parse(JSON.parse(read.stdout));
      if (issue.pull_request !== undefined && issue.pull_request !== null) return null;
      return IssueState.parse({ ...issue, state: issue.state.toUpperCase() });
    },
  });
}

const LINK_READ_QUERY = `query($owner: String!, $name: String!, $child: Int!, $parent: Int!) { repository(owner: $owner, name: $name) { child: issue(number: $child) { id parent { id number repository { nameWithOwner } } } wanted: issue(number: $parent) { id } } }`;
const LINK_MUTATION = `mutation($issueId: ID!, $subIssueId: ID!) { addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { number } subIssue { number } } }`;
const LinkRead = z.object({
  data: z.object({
    repository: z.object({
      child: z.object({
        id: z.string(),
        parent: z
          .object({
            id: z.string(),
            number: z.int(),
            repository: z.object({ nameWithOwner: z.string() }),
          })
          .nullable(),
      }),
      wanted: z.object({ id: z.string() }),
    }),
  }),
});

/**
 * Make `number` a sub-issue of `parent` unless it is one already. `issue.create` links only the
 * issues it files or finds by its own marker, so an issue found by title is linked here. Like
 * `issue.create`, it never moves an issue: one under another parent comes back as `conflict`
 * (`owner/repo#N`) with nothing changed. Check-then-act: a link made between the read and the
 * mutation makes `addSubIssue` refuse, and the retry reads it.
 */
export function linkSubIssue(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly parent: number; readonly number: number },
): Promise<{ changed: boolean; conflict: string | null }> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.link-sub-issue/1',
    input: { ...input },
    schema: z.object({ changed: z.boolean(), conflict: z.string().nullable() }),
    ...write,
    async run(context) {
      const repo = parseGithubRepo(input.repo);
      const graphql = (...rest: string[]): [string, ...string[]] => [
        'gh',
        'api',
        ...(repo.host === null ? [] : ['--hostname', repo.host]),
        'graphql',
        ...rest,
      ];
      const { child, wanted } = (
        await context.exec.json(
          graphql(
            '-f',
            `query=${LINK_READ_QUERY}`,
            '-f',
            `owner=${repo.owner}`,
            '-f',
            `name=${repo.name}`,
            '-F',
            `child=${String(input.number)}`,
            '-F',
            `parent=${String(input.parent)}`,
          ),
          { schema: LinkRead },
        )
      ).data.repository;
      const current = child.parent;
      if (current?.id === wanted.id) return { changed: false, conflict: null };
      if (current)
        return {
          changed: false,
          conflict: `${current.repository.nameWithOwner}#${String(current.number)}`,
        };
      await context.exec(
        graphql(
          '-f',
          `query=${LINK_MUTATION}`,
          '-f',
          `issueId=${wanted.id}`,
          '-f',
          `subIssueId=${child.id}`,
          '--silent',
        ),
      );
      return { changed: true, conflict: null };
    },
  });
}

/** An open issue found by its exact title. */
export const FoundIssue = z.object({ number: z.int(), title: z.string(), url: z.string() });
export type FoundIssue = z.output<typeof FoundIssue>;

/**
 * The open issue whose title is exactly `title`, or null: one search read, matched exactly in code.
 * `issue.create` reconciles only by its run-scoped marker, so a run restarted with a new run ID
 * looks for an earlier run's issue by title before filing, as the native helper did. The quoted
 * phrase keeps words such as "fix:" from being read as search qualifiers.
 */
export async function findOpenIssueByTitle(
  ctx: WorkflowContext,
  id: string,
  input: { readonly repo: string; readonly title: string },
): Promise<FoundIssue | null> {
  const listed = await ctx.exec.json(
    id,
    [
      'gh',
      'issue',
      'list',
      '-R',
      input.repo,
      '--state',
      'open',
      '--search',
      `"${input.title.replace(/"/g, '')}" in:title`,
      '--limit',
      '100',
      '--json',
      'number,title,url',
    ],
    { schema: z.array(FoundIssue), ...write },
  );
  return listed.find((issue) => issue.title === input.title) ?? null;
}

/** Append `line` to the ledger file unless an identical line is already there. */
export function appendLedger(
  ctx: WorkflowContext,
  id: string,
  input: { readonly file: string; readonly line: string },
): Promise<{ appended: boolean; lines: number }> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.ledger/1',
    input: { ...input },
    schema: z.object({ appended: z.boolean(), lines: z.int() }),
    async run() {
      const lines = existsSync(input.file)
        ? (await readFile(input.file, 'utf8')).split('\n').filter(Boolean)
        : [];
      if (lines.includes(input.line)) return { appended: false, lines: lines.length };
      await mkdir(dirname(input.file), { recursive: true });
      await appendFile(input.file, `${input.line}\n`);
      return { appended: true, lines: lines.length + 1 };
    },
  });
}
