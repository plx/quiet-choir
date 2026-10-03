// A stateful fake `gh` for the reconciled GitHub writes (test/github-writes.test.ts). It never
// reaches the network. Its state lives in the JSON file named by FAKE_GH_STATE: comments per issue,
// review threads, issues and code-scanning alerts, plus a call log of { argv, stdin }. A write whose
// route key equals `crashAfterCommit` is committed to the state file, the flag is cleared, and the
// process exits 1 with no stdout: a write GitHub committed whose response the step never saw.
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
  /** Commit a write; crash after it when armed, otherwise answer. */
  const committed = (route, value) => {
    if (state.crashAfterCommit === route) {
      state.crashAfterCommit = null;
      save();
      fail('connection reset by peer');
    }
    save();
    reply(value);
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
  fail(`unexpected ${method} ${target}`, 2);
}
