// A stateful fake `gh` for the reconciled GitHub writes (test/github-writes.test.ts and
// test/github-pr-writes.test.ts). It answers only `gh api` and never reaches the network. Its state
// lives in the JSON file named by FAKE_GH_STATE: comments per issue, review threads, issues,
// code-scanning alerts, pull requests and workflow runs, plus a call log of { argv, stdin }. A write
// whose route key equals `crashAfterCommit` is committed to the state file, the flag is cleared, and
// the process exits 1 with no stdout: a write GitHub committed whose response the step never saw.
//
// Pull request knobs: `pushBeforeMerge` moves the head to that SHA when the merge PUT arrives (so
// GitHub's sha check answers 409), `mergeError` answers the PUT with that error body and exit 1,
// a pull request with `mergeable: false` answers 405, and `mergeLag` makes that many reads after a
// merge still report the pull request unmerged. HTTP errors print GitHub's body on stdout and exit
// 1, as gh does.
import { readFileSync, writeFileSync } from 'node:fs';

// Writing and then calling process.exit can truncate stdout on a pipe, so every answer throws a
// Done, and the top level writes it and sets the exit code.
class Done {
  constructor(code, stdout, stderr) {
    Object.assign(this, { code, stdout, stderr });
  }
}
try {
  main();
} catch (error) {
  if (!(error instanceof Done)) throw error;
  process.stdout.write(error.stdout);
  process.stderr.write(error.stderr);
  process.exitCode = error.code;
}

function main() {
  const statePath = process.env.FAKE_GH_STATE;
  if (!statePath) throw new Done(2, '', 'fake gh: FAKE_GH_STATE is not set\n');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  let args = process.argv.slice(2);
  const stdin = args.includes('--input') ? readFileSync(0, 'utf8') : null;
  state.calls.push({ argv: ['gh', ...args], stdin });
  save();

  const fail = (message, code = 1) => {
    throw new Done(code, '', `gh: ${message}\n`);
  };
  const reply = (value) => {
    throw new Done(0, JSON.stringify(value), '');
  };
  /** Commit a write; crash after it when armed, otherwise answer (null: an empty body). */
  const committed = (route, value) => {
    if (state.crashAfterCommit === route) {
      state.crashAfterCommit = null;
      save();
      fail('connection reset by peer');
    }
    save();
    if (value === null) throw new Done(0, '', '');
    reply(value);
  };
  /** An HTTP error: gh prints GitHub's body on stdout and exits 1. */
  const httpError = (status, message, body = { message, status: String(status) }) => {
    save();
    throw new Done(
      1,
      JSON.stringify({ documentation_url: 'https://docs.github.com/rest', ...body }),
      `gh: ${message} (HTTP ${status})\n`,
    );
  };

  if (args[0] !== 'api') fail(`unexpected command ${args.join(' ')}`, 2);
  args = args.slice(1);
  if (args[0] === '--hostname') args = args.slice(2);
  const host = 'https://github.com';
  const repo = state.repo ?? 'octo-org/quiet-choir';
  const viewer = state.viewer ?? 'octo-bot';
  state.nextId ??= 1000;
  const nextId = () => ++state.nextId;

  /** -f/-F pairs of a GraphQL read. */
  function fields() {
    const values = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '-f' && args[index] !== '-F') continue;
      const [key, ...rest] = args[index + 1].split('=');
      values[key] = args[index] === '-F' ? Number(rest.join('=')) : rest.join('=');
    }
    return values;
  }
  const issueByNode = (nodeId) =>
    Object.values(state.issues ?? {}).find((i) => i.node_id === nodeId);

  if (args[0] === 'graphql') {
    if (stdin !== null) {
      const { query, variables } = JSON.parse(stdin);
      if (query.includes('addPullRequestReviewThreadReply')) {
        const thread = state.threads?.[variables.threadId];
        if (!thread) fail('Could not resolve to a node');
        const id = `PRRC_${nextId()}`;
        const comment = {
          id,
          url: `${host}/${repo}/pull/1#discussion_${id}`,
          body: variables.body,
          author: { login: viewer, __typename: 'Bot' },
        };
        thread.comments.push(comment);
        committed('graphql addPullRequestReviewThreadReply', {
          data: { addPullRequestReviewThreadReply: { comment: { id, url: comment.url } } },
        });
      }
      if (query.includes('resolveReviewThread')) {
        const thread = state.threads?.[variables.threadId];
        if (!thread) fail('Could not resolve to a node');
        thread.isResolved = true;
        committed('graphql resolveReviewThread', {
          data: { resolveReviewThread: { thread: { isResolved: true } } },
        });
      }
      if (query.includes('addSubIssue')) {
        const parent = issueByNode(variables.issueId);
        const child = issueByNode(variables.subIssueId);
        if (!parent || !child) fail('Could not resolve to a node');
        if (child.parent != null) fail('Sub issue may only have one parent');
        child.parent = parent.number;
        committed('graphql addSubIssue', {
          data: {
            addSubIssue: { issue: { number: parent.number }, subIssue: { number: child.number } },
          },
        });
      }
      fail(`unexpected mutation ${query}`, 2);
    }
    const { query, ...variables } = fields();
    if (query.includes('node(id: $threadId)')) {
      const thread = state.threads?.[variables.threadId];
      reply([
        {
          data: {
            node: thread
              ? {
                  __typename: 'PullRequestReviewThread',
                  isResolved: thread.isResolved,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: thread.comments,
                  },
                }
              : null,
          },
        },
      ]);
    }
    if (query.includes('viewer {'))
      reply({
        data: {
          viewer: { login: viewer },
          repository: {
            nameWithOwner: repo,
            isPrivate: false,
            viewerPermission: 'ADMIN',
            defaultBranchRef: { name: 'main' },
          },
        },
      });
    if (query.includes('child: issue(')) {
      const child = state.issues?.[variables.child];
      const wanted = state.issues?.[variables.parent];
      if (!child || !wanted) fail('Could not resolve to an Issue');
      const parent = child.parent == null ? null : state.issues[child.parent];
      reply({
        data: {
          repository: {
            child: {
              id: child.node_id,
              number: child.number,
              parent: parent
                ? { id: parent.node_id, number: parent.number, repository: { nameWithOwner: repo } }
                : null,
            },
            wanted: { id: wanted.node_id, number: wanted.number },
          },
        },
      });
    }
    if (query.includes('stateReason')) {
      const issue = state.issues?.[variables.number];
      if (!issue) fail('Could not resolve to an Issue');
      reply({
        data: {
          repository: {
            issue: {
              number: issue.number,
              state: issue.state.toUpperCase(),
              stateReason: issue.state_reason ? issue.state_reason.toUpperCase() : null,
            },
          },
        },
      });
    }
    fail(`unexpected query ${query}`, 2);
  }

  // REST
  const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
  const target = args.find((arg) => arg.startsWith('repos/'));
  if (!target) fail(`unexpected arguments ${args.join(' ')}`, 2);
  const prefix = `repos/${repo}/`;
  if (!target.startsWith(prefix)) fail('Not Found (HTTP 404)');
  const [path, search = ''] = target.slice(prefix.length).split('?');
  const params = new URLSearchParams(search);
  const body = stdin === null ? null : JSON.parse(stdin);
  let match;

  if ((match = /^issues\/(\d+)\/comments$/.exec(path))) {
    const number = match[1];
    state.comments ??= {};
    const list = (state.comments[number] ??= []);
    if (method === 'GET') reply(list);
    if (method === 'POST') {
      const id = nextId();
      const comment = {
        id,
        user: { login: viewer },
        body: body.body,
        created_at: '2026-10-03T00:00:00Z',
        updated_at: '2026-10-03T00:00:00Z',
        html_url: `${host}/${repo}/issues/${number}#issuecomment-${id}`,
      };
      list.push(comment);
      committed(`POST issues/${number}/comments`, comment);
    }
  }
  if (path === 'issues') {
    state.issues ??= {};
    if (method === 'GET') {
      const perPage = Number(params.get('per_page') ?? 30);
      const page = Number(params.get('page') ?? 1);
      const rows = Object.values(state.issues)
        .filter((issue) => issue.creator === params.get('creator'))
        .sort((left, right) => right.number - left.number)
        .slice((page - 1) * perPage, page * perPage)
        .map((issue) => ({
          number: issue.number,
          html_url: `${host}/${repo}/issues/${issue.number}`,
          node_id: issue.node_id,
          body: issue.body,
          ...(issue.pull_request ? { pull_request: { url: 'x' } } : {}),
        }));
      reply(rows);
    }
    if (method === 'POST') {
      const number = Math.max(0, ...Object.keys(state.issues).map(Number)) + 1;
      const issue = {
        number,
        node_id: `I_${number}`,
        title: body.title,
        body: body.body,
        labels: body.labels ?? [],
        state: 'open',
        state_reason: null,
        creator: viewer,
        parent: null,
      };
      state.issues[number] = issue;
      committed('POST issues', {
        number,
        html_url: `${host}/${repo}/issues/${number}`,
        node_id: issue.node_id,
      });
    }
  }
  if ((match = /^issues\/(\d+)$/.exec(path)) && method === 'PATCH') {
    const issue = state.issues?.[match[1]];
    if (!issue) fail('Not Found (HTTP 404)');
    issue.state = body.state;
    issue.state_reason = body.state === 'open' ? 'reopened' : (body.state_reason ?? 'completed');
    committed(`PATCH issues/${match[1]}`, {
      number: issue.number,
      state: issue.state,
      state_reason: issue.state_reason,
    });
  }
  if ((match = /^code-scanning\/alerts\/(\d+)$/.exec(path))) {
    const alert = state.alerts?.[match[1]];
    if (!alert) fail('Not Found (HTTP 404)');
    const view = () => ({
      number: alert.number,
      state: alert.state,
      dismissed_reason: alert.dismissed_reason ?? null,
      dismissed_comment: alert.dismissed_comment ?? null,
      most_recent_instance: { location: alert.path === null ? {} : { path: alert.path } },
    });
    if (method === 'GET') reply(view());
    if (method === 'PATCH') {
      alert.state = body.state;
      alert.dismissed_reason = body.dismissed_reason;
      alert.dismissed_comment = body.dismissed_comment;
      committed(`PATCH code-scanning/alerts/${match[1]}`, view());
    }
  }
  const owner = repo.split('/')[0];
  const pullView = (pull) => ({
    url: `https://api.github.com/repos/${repo}/pulls/${pull.number}`,
    number: pull.number,
    node_id: pull.node_id,
    html_url: `${host}/${repo}/pull/${pull.number}`,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: pull.draft ?? false,
    merged: pull.merged,
    merged_at: pull.merged ? '2026-10-03T00:00:00Z' : null,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable ?? true,
    head: { label: `${owner}:${pull.head}`, ref: pull.head, sha: pull.head_sha },
    base: { label: `${owner}:${pull.base}`, ref: pull.base, sha: 'b'.repeat(40) },
  });

  if (path === 'pulls') {
    state.pulls ??= {};
    if (method === 'GET') {
      const rows = Object.values(state.pulls)
        .filter(
          (pull) =>
            `${owner}:${pull.head}` === params.get('head') &&
            (!params.has('base') || pull.base === params.get('base')),
        )
        .sort((left, right) => right.number - left.number)
        .map((pull) => {
          // List rows have no merged or mergeable field, only merged_at.
          const row = pullView(pull);
          delete row.merged;
          delete row.mergeable;
          return row;
        });
      reply(rows);
    }
    if (method === 'POST') {
      if (
        Object.values(state.pulls).some(
          (pull) => pull.state === 'open' && pull.head === body.head && pull.base === body.base,
        )
      )
        httpError(422, 'Validation Failed', {
          message: 'Validation Failed',
          errors: [{ message: `A pull request already exists for ${owner}:${body.head}.` }],
          status: '422',
        });
      const number =
        Math.max(
          0,
          ...Object.keys(state.issues ?? {}).map(Number),
          ...Object.keys(state.pulls).map(Number),
        ) + 1;
      const pull = {
        number,
        node_id: `PR_${number}`,
        head: body.head,
        head_sha: state.branches?.[body.head] ?? 'a'.repeat(40),
        base: body.base,
        title: body.title,
        body: body.body,
        draft: body.draft ?? false,
        state: 'open',
        merged: false,
        merge_commit_sha: null,
      };
      state.pulls[number] = pull;
      committed('POST pulls', pullView(pull));
    }
  }
  if ((match = /^pulls\/(\d+)$/.exec(path))) {
    const pull = state.pulls?.[match[1]];
    if (!pull) httpError(404, 'Not Found');
    if (method === 'GET') {
      if (pull.merged && state.mergeLag > 0) {
        state.mergeLag -= 1;
        save();
        reply({ ...pullView(pull), state: 'open', merged: false, merge_commit_sha: null });
      }
      reply(pullView(pull));
    }
    if (method === 'PATCH') {
      for (const key of ['title', 'body', 'base']) if (key in body) pull[key] = body[key];
      committed(`PATCH pulls/${match[1]}`, pullView(pull));
    }
  }
  if ((match = /^pulls\/(\d+)\/merge$/.exec(path)) && method === 'PUT') {
    const pull = state.pulls?.[match[1]];
    if (!pull) httpError(404, 'Not Found');
    const { merge_method: mergeMethod, sha } = fields();
    if (state.pushBeforeMerge) {
      pull.head_sha = state.pushBeforeMerge;
      state.pushBeforeMerge = null;
    }
    if (state.mergeError) {
      const error = state.mergeError;
      state.mergeError = null;
      httpError(error.status ?? 'unknown', error.message, error);
    }
    if (pull.merged || pull.state !== 'open') httpError(405, 'Pull Request is not mergeable');
    if (sha !== undefined && sha !== pull.head_sha)
      httpError(409, 'Head branch was modified. Review and try the merge again.');
    if (pull.mergeable === false) httpError(405, 'Pull Request is not mergeable');
    pull.merged = true;
    pull.state = 'closed';
    pull.merge_method = mergeMethod;
    pull.merge_commit_sha = 'c'.repeat(39) + String(pull.number % 10);
    committed(`PUT pulls/${match[1]}/merge`, {
      sha: pull.merge_commit_sha,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }
  if (path === 'actions/runs' && method === 'GET') {
    const runs = Object.values(state.runs ?? {})
      .filter((run) => run.head_sha === params.get('head_sha'))
      .sort((left, right) => right.id - left.id)
      .map((run) => ({ ...run, html_url: `${host}/${repo}/actions/runs/${run.id}` }));
    const total_count = state.runsTotalCount ?? runs.length;
    // runsPages: explicit pages of run IDs, so a page-boundary duplicate can be seeded.
    const pages = state.runsPages
      ? state.runsPages.map((ids) => ({
          total_count,
          workflow_runs: ids.map((runId) => runs.find((run) => run.id === runId)).filter(Boolean),
        }))
      : [{ total_count, workflow_runs: runs }];
    reply(args.includes('--slurp') ? pages : pages[0]);
  }
  if ((match = /^actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(path)) && method === 'POST') {
    const run = state.runs?.[match[1]];
    if (!run) httpError(404, 'Not Found');
    if (run.status !== 'completed') httpError(403, 'This workflow is already running');
    run.run_attempt += 1;
    run.status = 'queued';
    run.conclusion = null;
    committed(`POST actions/runs/${match[1]}/rerun-failed-jobs`, null);
  }
  fail(`unexpected ${method} ${target}`, 2);
}
