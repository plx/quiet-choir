export const meta = {
  name: 'merge-down-pr',
  description:
    'Land one PR: rebase onto main, triage Codex threads, review against its issue, fix, gate on CI + Codex, squash-merge, report',
  whenToUse:
    'Merging down a stack of agent-authored PRs (or Dependabot PRs) one PR per run, in stack order. Args: {pr, followupEpic?, parentEpic?, until?}.',
  phases: [
    { title: 'Prepare', detail: 'snapshot PR state and rebase onto the default branch (haiku)' },
    {
      title: 'Rebase',
      detail: 'resolve conflicts semantically (opus high; sonnet for dependencies)',
    },
    {
      title: 'Review',
      detail: 'local checks ∥ thread triage + review (opus medium → xhigh on escalation)',
    },
    {
      title: 'Fix',
      detail: 'implement decisions (sonnet high or opus high) ∥ file follow-ups (sonnet)',
    },
    { title: 'Gate', detail: 'push, reply, request Codex, wait for CI + Codex (haiku)' },
    { title: 'Land', detail: 'squash-merge and verify the issue closed (haiku)' },
    { title: 'Report', detail: 'issue summary comment and ledger line (sonnet)' },
  ],
};

/*
 * merge-down-pr — land exactly one PR, the way a careful maintainer would.
 *
 * WHAT IT DOES
 *   1. Prepare  Snapshot the PR (issue, review threads, CI, Codex activity) and rebase its own
 *               commits onto the default branch in a dedicated worktree. For stacked PRs whose
 *               parent was squash-merged, the fork point recorded before the stack was rewritten
 *               keeps the rebase to the PR's own commits.
 *   2. Rebase   If git stops on conflicts, an agent resolves them semantically (adapting the PR to
 *               whatever changed beneath it), not by picking sides.
 *   3. Review   In parallel: the local check suite, and one reviewer that triages every
 *               unresolved review thread (valid → fix / out of scope → follow-up / invalid →
 *               explain) and reviews the PR against its issue. Suspected blockers escalate to a
 *               deeper reviewer whose assessment replaces the first.
 *   4. Fix      In parallel: an implementer applies the fix decisions (model chosen by the
 *               reviewer's complexity rating), and a scribe files out-of-scope follow-ups under a
 *               follow-up epic (created on first use).
 *   5. Gate     Retarget to the default branch, push with lease, reply to and resolve threads,
 *               request "@codex review" when the PR's own code changed (or Codex never reviewed
 *               it), then wait for CI and Codex. New Codex threads or red CI loop back through
 *               triage and fix, bounded by maxCodexRounds / maxCiRepairs.
 *   6. Land     Squash-merge pinned to the gated head SHA; confirm the issue closed (closing it
 *               explicitly if GitHub did not).
 *   7. Report   Post a summary comment on the issue when there is something worth recording, and
 *               return a ledger record for the whole merge-down.
 *   Dependabot PRs take the same path with a dependency review instead (merge / fix / close with
 *   an "@dependabot ignore" command / defer) and no Codex round.
 *
 * INVOCATION
 *   Workflow({ name: 'merge-down-pr', args: { pr: 66, followupEpic: 123, parentEpic: 32 } })
 *   args.pr               required; the PR to land
 *   args.followupEpic     epic that follow-up issues attach to; created on first use if absent
 *                         (the result's followupEpic carries the number to pass to later runs)
 *   args.followupEpicTitle  title for a newly created follow-up epic
 *   args.parentEpic       epic the landed issues belong to (context for follow-ups)
 *   args.standingNotes    decisions made earlier in a stack walk that every reviewer should
 *                         apply without re-litigating (array of strings)
 *   args.until            'prepare' | 'review' | 'fix' | 'merge' (default). Anything short of
 *                         'merge' publishes nothing: no pushes, comments, issues, or merges.
 *   args.codex            'auto' (default) | 'always' | 'never' — when to request a Codex review
 *   args.maxCodexRounds   Codex re-reviews per run (default 3). Past that, re-reviews continue
 *                         only while the latest round found a real major or blocker, up to
 *   args.codexRoundsHardCap  (default 5). When re-reviews stop, remaining findings are still
 *                         triaged and fixed, then gated on CI only
 *   args.maxCiRepairs     CI-failure repair attempts (default 2)
 *   args.root             directory holding worktree/ and state/ (default: <main checkout>-merge-down)
 *   args.tools            path to merge-down.mjs (default: relative to the repository root)
 *
 * INVARIANTS AND EXPECTATIONS
 *   - One PR per run. Stacked PRs must be landed bottom-up; a PR whose base PR is still open is
 *     refused ("blocked") rather than rebased past it.
 *   - All branch surgery happens in the dedicated worktree; the invoking checkout is never touched.
 *   - Nothing is force-pushed over someone else's work (lease on the last head we saw), and the
 *     merge is pinned to the exact head that passed the gate.
 *   - Fixes stay within the linked issue's scope and intent; anything else becomes a follow-up.
 *   - Any failure the workflow cannot settle returns status "blocked" with the stage and reason,
 *     leaving the PR open. Re-running is safe: every step re-reads GitHub and git state.
 *
 * MODEL TIERS (the point of the exercise: spend judgment only where judgment is needed)
 *   clerk     haiku  / low     run merge-down.mjs subcommands and relay their JSON
 *   scribe    sonnet / medium  write comments and issues from decisions already made
 *   mechanic  sonnet / high    mechanical fixes, dependency reviews, lockfile conflicts
 *   reviewer  opus   / medium  first-pass review and thread triage
 *   surgeon   opus   / high    subtle fixes and semantic conflict resolution
 *   judge     opus   / xhigh   escalated review only
 *
 * All git/GitHub mechanics live in merge-down-pr/merge-down.mjs (one JSON object per command), so
 * agents never improvise plumbing and each mechanic can be run by hand.
 */

const TIER = {
  clerk: { model: 'haiku', effort: 'low' },
  scribe: { model: 'sonnet', effort: 'medium' },
  mechanic: { model: 'sonnet', effort: 'high' },
  reviewer: { model: 'opus', effort: 'medium' },
  surgeon: { model: 'opus', effort: 'high' },
  judge: { model: 'opus', effort: 'xhigh' },
};

const A = {
  pr: Number(args?.pr),
  tools: args?.tools ?? '.claude/workflows/merge-down-pr/merge-down.mjs',
  root: args?.root ?? null,
  until: args?.until ?? 'merge',
  codex: args?.codex ?? 'auto',
  maxCodexRounds: args?.maxCodexRounds ?? 3,
  codexRoundsHardCap: args?.codexRoundsHardCap ?? 5,
  maxCiRepairs: args?.maxCiRepairs ?? 2,
  followupEpic: args?.followupEpic ?? null,
  followupEpicTitle: args?.followupEpicTitle ?? 'Epic: initial enhancements, wave 2',
  parentEpic: args?.parentEpic ?? null,
  standingNotes: args?.standingNotes ?? [],
};
const STAGES = ['prepare', 'review', 'fix', 'merge'];
if (!Number.isInteger(A.pr) || A.pr <= 0) {
  return { status: 'error', reason: 'args.pr (a pull request number) is required' };
}
if (!STAGES.includes(A.until)) {
  return { status: 'error', reason: `args.until must be one of ${STAGES.join(', ')}` };
}
const publishing = A.until === 'merge';

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const arr = (items) => ({ type: 'array', items });
const oneOf = (...values) => ({ type: 'string', enum: values });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});

const SEVERITY = oneOf('blocker', 'major', 'minor');
const COMPLEXITY = oneOf('mechanical', 'subtle');
const THREAD = obj({
  id: str,
  title: str,
  verdict: oneOf('valid', 'partly-valid', 'invalid', 'obsolete'),
  action: oneOf('fix', 'defer', 'reject', 'none'),
  severity: SEVERITY,
  complexity: COMPLEXITY,
  plan: str,
  reply: str,
});
const FINDING = obj({
  id: str,
  title: str,
  severity: SEVERITY,
  disposition: oneOf('fix', 'follow-up', 'note'),
  complexity: COMPLEXITY,
  detail: str,
  plan: str,
  files: arr(str),
});
const REVIEW = obj({
  threads: arr(THREAD),
  findings: arr(FINDING),
  alignment: obj({
    verdict: oneOf('complete', 'mostly', 'partial', 'misaligned', 'no-issue'),
    notes: str,
  }),
  issueDisposition: obj({ action: oneOf('close', 'keep-open', 'none'), remaining: arr(str) }),
  escalate: bool,
  escalateReason: str,
  summaryNotes: arr(str),
});
const TRIAGE = obj({ threads: arr(THREAD), notes: arr(str) });
const DEPENDENCY_REVIEW = obj({
  decision: oneOf('merge', 'fix', 'close', 'defer'),
  rationale: str,
  fixes: arr(obj({ id: str, title: str, plan: str, complexity: COMPLEXITY })),
  closeComment: str,
  followups: arr(obj({ id: str, title: str, detail: str, plan: str })),
  headline: str,
});
const RESOLVE = obj({
  completed: bool,
  head: str,
  resolutions: arr(obj({ file: str, how: str })),
  concerns: arr(str),
});
const FIX = obj({
  items: arr(
    obj({ key: str, status: oneOf('fixed', 'partly', 'not-fixed'), commit: str, summary: str }),
  ),
  checkPassed: bool,
  head: str,
  notes: arr(str),
});
const FILED = obj({
  epic: obj({ number: num, url: str, created: bool }),
  issues: arr(
    obj({
      key: str,
      number: num,
      url: str,
      title: str,
      action: oneOf('created', 'commented-existing'),
    }),
  ),
});
const REPORT = obj({ posted: bool, commentUrl: str, headline: str });

// ── Run state ────────────────────────────────────────────────────────────────────────────────

const record = {
  pr: A.pr,
  url: null,
  title: null,
  kind: null,
  status: 'running',
  issue: null,
  mergeCommit: null,
  rebase: null,
  review: { escalated: false, alignment: null, findings: [] },
  threads: [],
  codexReviewsRequested: 0,
  rounds: 0,
  ciRepairs: 0,
  followups: [],
  followupEpic: A.followupEpic,
  summaryCommentUrl: null,
  headline: null,
  notes: [],
  blocked: null,
};
// Models sometimes HTML-escape plain text; ledger text should read as written.
const plain = (text) =>
  typeof text === 'string'
    ? text
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
    : text;
const finish = (status, extra = {}) => {
  Object.assign(record, { status }, extra);
  record.headline = plain(record.headline);
  return record;
};
const blocked = (stage, reason) => {
  log(`Blocked at ${stage}: ${reason}`);
  return finish('blocked', { blocked: { stage, reason } });
};

let TOOL = A.tools;
let ROOT = A.root;
let clerkRuns = 0;

// Run merge-down.mjs subcommands through a haiku clerk and parse each command's JSON output.
// ── Verified relay ───────────────────────────────────────────────────────────────────────────
// Clerks copy merge-down.mjs output into their final message. The helper stamps each output with
// the caller's nonce and an FNV-1a hash of everything else, so a mangled or stale copy is caught
// here. A retry re-reads the saved output (`merge-down.mjs last`) rather than repeating the effect.

function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function verify(value, nonce) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { _fnv, ...payload } = value;
  if (_fnv !== fnv(JSON.stringify(payload)) || payload._nonce !== nonce) return null;
  const { _nonce, ...data } = payload;
  return data;
}

function parseObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

let nonceSeq = 0;
// Paths reach Bash inside generated commands: quote anything that is not plainly safe.
const sh = (value) =>
  /^[\w@%+=:,./-]+$/.test(String(value))
    ? String(value)
    : `'${String(value).replace(/'/g, `'\\''`)}'`;
const toolFlags = () => `--pr ${A.pr}${ROOT ? ` --root ${sh(ROOT)}` : ''}`;

// One helper invocation. Nonces come from a counter, so they are stable across workflow resume.
function step(id, sub, flags = '', stdin = null) {
  const nonce = `n${++nonceSeq}`;
  const base = `node ${sh(TOOL)} ${sub} ${toolFlags()} --nonce ${nonce}${flags ? ` ${flags}` : ''}`;
  const run = stdin === null ? base : `${base} <<'MERGE_DOWN_EOF'\n${stdin}\nMERGE_DOWN_EOF`;
  return { id, sub, nonce, run };
}

const RELAY_RULES = `Your final message must be exactly one JSON object that maps each command id to the line of JSON that command printed, copied character for character: keep every field, including "_nonce" and "_fnv", and change nothing, not even paths. For example: {"first": {...}, "second": {...}}. No prose and no code fences. Leave out ids of commands you did not run.`;

const RUN_STEPS = (
  listing,
) => `Run each command below with the Bash tool, one at a time, in order, from the current directory, with a 600000 ms timeout. Pass each command to Bash exactly as written (multi-line commands include a heredoc). Do not run anything else and do not interpret the output. If a command exits non-zero, stop there.

${listing}

${RELAY_RULES}`;

async function relay(label, phaseName, steps, render = RUN_STEPS) {
  const listing = steps.map((c) => `<command id="${c.id}">\n${c.run}\n</command>`).join('\n\n');
  clerkRuns++;
  const text = await agent(render(listing), { ...TIER.clerk, label, phase: phaseName });
  // A clerk that died (API error, usage limit) is not a corrupted relay: say so, don't guess.
  if (text === null) return { verified: {}, missing: steps, dead: true };
  const copied = parseObject(text) ?? {};
  const verified = {};
  const missing = [];
  let failedEarlier = false;
  for (const s of steps) {
    const data = verify(copied[s.id], s.nonce);
    if (data) {
      verified[s.id] = data;
      failedEarlier ||= Boolean(data.error);
    } else if (failedEarlier) {
      verified[s.id] = { error: 'not run: an earlier command failed' };
    } else {
      missing.push(s);
    }
  }
  return { verified, missing, dead: false };
}

// Run helper steps through a haiku clerk; returns {id: verified output}. Unverifiable outputs are
// re-read from disk up to twice, then reported as errors.
async function clerk(label, phaseName, steps, render = RUN_STEPS) {
  const first = await relay(label, phaseName, steps, render);
  const out = first.verified;
  let missing = first.missing;
  let dead = first.dead;
  for (let i = 1; i <= 2 && missing.length; i++) {
    const rereads = missing.map((s) => ({
      ...s,
      run: `node ${sh(TOOL)} last ${toolFlags()} --cmd ${s.sub}`,
    }));
    const again = await relay(`${label} (re-read ${i})`, phaseName, rereads);
    Object.assign(out, again.verified);
    missing = again.missing;
    // Two dead clerks in a row: the model API is unavailable, and more re-reads would die too.
    if (dead && again.dead) break;
    dead = again.dead;
  }
  for (const s of missing) {
    out[s.id] = {
      error: dead
        ? `the clerk agent died before relaying "${s.sub}" (API error or usage limit); re-run once the API is available`
        : `no verifiable output from "${s.sub}" (not run, or the relay was corrupted)`,
    };
  }
  return out;
}

// ── Prepare ──────────────────────────────────────────────────────────────────────────────────

phase('Prepare');
const prepared = await clerk(`prepare #${A.pr}`, 'Prepare', [step('prepare', 'prepare')]);
const prep = prepared.prepare;
if (prep.error || !prep.pr || !prep.sync)
  return blocked('prepare', prep.error ?? 'no output from prepare');

const PR = prep.pr;
const SYNC = prep.sync;
const REPO = prep.repo;
const DEF = prep.defaultBranch;
const W = prep.paths.workdir;
const DIR = PR.files.dir;
const ISSUE = PR.issue;
const kind = PR.isDependency ? 'dependency' : 'change';
TOOL = `${prep.paths.toolsDir}/merge-down.mjs`;
ROOT = prep.paths.root;
Object.assign(record, {
  url: PR.url,
  title: PR.title,
  kind,
  issue: ISSUE
    ? { number: ISSUE.number, url: ISSUE.url, title: ISSUE.title, state: ISSUE.state }
    : null,
  rebase: {
    status: SYNC.status,
    forkSource: SYNC.forkSource ?? null,
    conflicts: SYNC.conflictedFiles ?? [],
  },
});
log(
  `#${A.pr} ${PR.title} — ${kind}${ISSUE ? `, issue #${ISSUE.number}` : ''}; rebase ${SYNC.status}; ` +
    `${PR.codex.unresolvedThreads} open Codex thread(s); CI ${PR.ci.state}`,
);

if (PR.state !== 'OPEN') return finish('skipped', { notes: [`PR is ${PR.state}`] });
if (PR.isDraft) return blocked('prepare', 'PR is a draft');
if (ISSUE?.alsoCloses?.length) {
  // GitHub would close all of them on merge, but the review judges the PR against one issue.
  const all = [ISSUE.number, ...ISSUE.alsoCloses].map((n) => `#${n}`).join(', ');
  return blocked('prepare', `PR closes several issues (${all}); split it or land it by hand`);
}
if (SYNC.status === 'blocked') return blocked('rebase', SYNC.reason);
if (SYNC.status === 'error')
  return blocked('rebase', `rebase failed without conflicts; see ${SYNC.log}`);
if (SYNC.forkSource && SYNC.forkSource !== 'recorded' && PR.baseRef !== DEF) {
  record.notes.push(
    `fork point came from ${SYNC.forkSource}, not a recorded ref; verify the rebase kept only this PR's commits`,
  );
}
if (A.until === 'prepare') return finish('stopped', { prepared: prep });

const situation =
  () => `Repository ${REPO}, PR #${A.pr} "${PR.title}" (${PR.url})${ISSUE ? `, which implements issue #${ISSUE.number} "${ISSUE.title}"` : ', which has no linked issue'}.
The PR is checked out, rebased onto ${DEF}, in the dedicated git worktree ${W} (local branch ${SYNC.localBranch}). Work only there: use absolute paths with file tools and \`cd ${sh(W)} && …\` or \`git -C ${sh(W)} …\` in shell commands. Never touch other checkouts or branches, and never push.
Files describing the PR are in ${DIR}: body.md (description), issue.md (issue and its comments), own.stat / own.diff / commits.txt (the PR's changes against ${DEF}), threads.md (unresolved review threads), stack.md (later PRs stacked on this one)${SYNC.forkPoint ? ', upstream-delta.stat / upstream-delta.patch (what changed beneath the PR since it was written)' : ''}.`;

const standing = A.standingNotes.length
  ? `\nStanding decisions for this merge-down (apply them; don't re-litigate):\n${A.standingNotes.map((n) => `- ${n}`).join('\n')}\n`
  : '';

const guidance = `Before editing, read ${W}/CLAUDE.md (or AGENTS.md) and any CLAUDE.md in directories you touch, and follow them.`;

// ── Rebase: semantic conflict resolution ────────────────────────────────────────────────────

if (SYNC.status === 'conflict') {
  phase('Rebase');
  const resolution = await agent(
    `You are finishing a semantic rebase. This PR's own commits are being replayed onto ${DEF}, and git stopped with conflicts. The rebase is in progress in ${W}.

${situation()}

The PR was written on top of an older base. ${DIR}/upstream-delta.stat and upstream-delta.patch show everything that changed beneath it since — for a stacked PR, mostly review fixes applied to the PR below it before that one merged. The PR's original commits: \`git -C ${sh(W)} log --oneline ${SYNC.forkPoint}..${SYNC.origHead}\`.

Conflicted files now: ${SYNC.conflictedFiles.join(', ')}
${standing}

Resolve so the result keeps both the PR's intent and the upstream changes: a semantic merge, not picking a side. If upstream renamed or reshaped something this PR uses or extends, adapt the PR's code to the new shape, including in files without textual conflicts when you notice them. For package-lock.json, take the new base's version (\`git checkout --ours package-lock.json\`; during a rebase "ours" is the new base), run \`npm install --no-audit --no-fund\` in ${W} to reconcile it with package.json, and stage it.
Stage your resolutions and continue with \`cd ${sh(W)} && GIT_EDITOR=true git rebase --continue\`; repeat for any later conflicting commit. Never skip commits, abort, or push.
${guidance} A quick \`cd ${sh(W)} && npx tsc --noEmit -p tsconfig.json\` can confirm types; the full check suite runs in a later stage.
When the rebase has completed, run \`node ${sh(TOOL)} snapshot --pr ${A.pr} --root ${sh(ROOT)}\` and report its head.
Return completed, head, one entry per file you resolved non-trivially (what you kept or adapted, and why), and any concerns a reviewer should double-check.`,
    {
      ...(kind === 'dependency' ? TIER.mechanic : TIER.surgeon),
      label: 'resolve conflicts',
      phase: 'Rebase',
      schema: RESOLVE,
    },
  );
  if (!resolution?.completed) {
    return blocked(
      'rebase',
      resolution?.concerns?.join('; ') || 'conflict resolution did not complete',
    );
  }
  // Don't take the resolver's word for it: the snapshot fails while a rebase is still in progress,
  // and a rebase that lost the PR's commits leaves nothing of its own to publish.
  const verified = (await clerk('verify rebase', 'Rebase', [step('snapshot', 'snapshot')]))
    .snapshot;
  if (verified.error) return blocked('rebase', `rebase not finished: ${verified.error}`);
  if (!verified.ownCommits) return blocked('rebase', "the rebase left none of the PR's commits");
  if (SYNC.originalCommits && verified.ownCommits < SYNC.originalCommits) {
    record.notes.push(
      `rebase kept ${verified.ownCommits} of ${SYNC.originalCommits} commits (some became empty); check the history`,
    );
  }
  record.rebase.resolutions = resolution.resolutions;
  record.rebase.concerns = resolution.concerns;
}

// ── Review (∥ local checks) ─────────────────────────────────────────────────────────────────

const rebaseNote = () => {
  if (SYNC.status === 'conflict') {
    return `The rebase needed conflict resolution; double-check these spots: ${JSON.stringify(record.rebase.resolutions)}. Concerns raised: ${JSON.stringify(record.rebase.concerns ?? [])}.`;
  }
  if (SYNC.status === 'rebased')
    return `The rebase onto ${DEF} applied cleanly (upstream change: ${SYNC.upstreamDelta || 'n/a'}).`;
  return `The PR already contained the tip of ${DEF}; no rebase was needed.`;
};

function changeReviewPrompt() {
  return `You are the pre-merge reviewer for this PR. Your decisions drive everything downstream: what another agent fixes now (from your plans), what becomes a follow-up issue, what review feedback gets rejected, and what is recorded on the issue. You do not edit code.

${situation()}
${rebaseNote()}

${PR.laterInStack ? `This PR is one of a stack: ${PR.laterInStack} later PR(s), listed in stack.md, are already written and land after it. When something you would fix here is clearly the subject of a later PR's issue, don't duplicate it: record it as a note ("addressed by #N") instead; open \`gh issue view <n> -R ${REPO}\` when unsure.\n` : ''}${A.parentEpic ? `The work belongs to epic #${A.parentEpic}; read it (\`gh issue view ${A.parentEpic} -R ${REPO}\`) if you need the broader plan.\n` : ''}
Read issue.md, body.md, and own.stat, then own.diff (skim generated or vendored content such as large fixtures and lockfiles). Open files in the worktree for context as needed.

1. Review threads: threads.md has ${PR.codex.unresolvedThreads + PR.otherUnresolvedThreads} unresolved thread(s), mostly from Codex's automated review of the pre-rebase code, so line numbers may have moved. For each thread decide:
   - verdict: valid | partly-valid | invalid | obsolete (already handled, or no longer applies)
   - action: fix (in this PR) | defer (valid, but beyond this issue's scope; becomes a follow-up issue) | reject | none (obsolete)
   - A thread can diagnose a real problem and still suggest the wrong fix: plan the fix you actually want.
   - reply: 1–3 sentences to post on the thread (fix: what will change; reject: why not; defer: why it is out of scope). The workflow appends the fixing commit or follow-up issue number.
   Use the thread ids exactly as they appear in threads.md (an open code-scanning alert with no review thread appears there as alert:N; decide it under that id). Threads by github-advanced-security are CodeQL code-scanning alerts: fix real problems (prefer a cheap safer pattern when one exists), and reject only genuine false positives or test-only patterns, with a justification; the workflow dismisses a rejected alert.
2. Your own review. Alignment: does the PR deliver what the issue asks? Walk its acceptance criteria; note gaps and scope creep. Quality: correctness, durability and replay hazards, missing tests for new behavior, documentation or skill text that no longer matches the code, awkward public API. Report only findings worth acting on: no style nits the linters don't enforce, no restating what the code does.
   For each finding give severity (blocker | major | minor); disposition — fix (within the issue's scope and intent), follow-up (worthwhile but outside it), or note (record only); complexity — mechanical (a competent engineer would implement your plan the same way; goes to a mid-tier model) or subtle (needs careful reasoning about runtime semantics, concurrency, or durability; goes to a stronger model); and a concrete plan. A fix may complete or correct what the issue asked for; anything else is a follow-up.
3. issueDisposition: close when merging completes the issue; keep-open when the PR or issue explicitly leaves work for after the merge (list what remains); none when there is no linked issue.
4. escalate: true only if you suspect a blocker you could not confirm, or the PR substantially misses the issue. A deeper reviewer then re-examines; say exactly what to look at in escalateReason.
5. summaryNotes: 0–6 short bullets worth recording on the issue (decisions, trade-offs, deviations from the issue's proposal, known limits). Leave empty if nothing is notable.

Plans describe code and documentation changes only. The workflow does all GitHub publishing (thread replies, issue comments, follow-up issues), so never plan a comment or other GitHub action.
${standing}
The local check suite is running in parallel, and the fix stage handles any failure it reports; don't run the suite yourself.`;
}

function dependencyReviewPrompt() {
  const ci =
    PR.ci.state === 'failure'
      ? `\nGitHub CI for the PR's original head failed on: ${PR.ci.failed.join(', ')}. Details: \`gh pr checks ${A.pr} -R ${REPO}\` and \`gh run view <run-id> -R ${REPO} --log-failed\`.`
      : '';
  return `You review a Dependabot dependency-update PR before it merges. You do not edit code.

${situation()}
${rebaseNote()}${ci}

Read body.md (Dependabot's release notes and changelog excerpts) and own.diff (package.json and lockfile changes). Check how this repository uses the updated packages (search the worktree) and its deliberate version policies: package.json "engines", .nvmrc, documentation, and tests that assert pinned versions.
Decide:
- merge: nothing needs to change.
- fix: small, in-scope changes make it correct (for example, bump a companion package in lockstep, update a pinned-version assertion, or rename a changed config option). Give exact plans; complexity is usually mechanical.
- close: the update contradicts a deliberate policy (for example, @types/node tracks the minimum supported Node.js version). Write the full closing comment, ending with the Dependabot command that prevents re-proposal (\`@dependabot ignore this major version\`, \`@dependabot ignore this minor version\`, or \`@dependabot ignore this dependency\`).
- defer: needs a real migration beyond a small fix; explain what it needs in rationale and followups.
The local check suite is running in parallel; the fix stage handles failures it reports.
Return decision, rationale, fixes, closeComment ('' unless closing), followups (usually empty), and headline: one sentence for a ledger of the merge-down. Write plain text (no HTML entities).`;
}

const majorBump = (() => {
  const m = /from v?(\d+)\S* to v?(\d+)/i.exec(PR.title);
  return m ? Number(m[2]) > Number(m[1]) : false;
})();

phase('Review');
const [checked, firstReview] = await parallel([
  () => clerk('local checks', 'Review', [step('check', 'check', '--label check-0')]),
  () =>
    kind === 'dependency'
      ? agent(dependencyReviewPrompt(), {
          ...(majorBump ? TIER.reviewer : TIER.mechanic),
          label: 'dependency review',
          phase: 'Review',
          schema: DEPENDENCY_REVIEW,
        })
      : agent(changeReviewPrompt(), {
          ...TIER.reviewer,
          label: 'review',
          phase: 'Review',
          schema: REVIEW,
        }),
]);
const check0 = checked?.check ?? { passed: false, error: 'local checks produced no output' };
if (!firstReview) return blocked('review', 'reviewer returned nothing');
log(`Local checks ${check0.passed ? 'pass' : `fail at ${check0.failedStep ?? check0.error}`}`);

let review = firstReview;
if (kind === 'change') {
  const blockers = review.findings.filter((f) => f.severity === 'blocker').length;
  const majorFixes = review.findings.filter(
    (f) => f.severity === 'major' && f.disposition === 'fix',
  ).length;
  const reasons = [
    review.escalate ? review.escalateReason || 'reviewer requested escalation' : null,
    blockers ? `${blockers} blocker finding(s)` : null,
    ['partial', 'misaligned'].includes(review.alignment.verdict)
      ? `alignment is ${review.alignment.verdict}`
      : null,
    majorFixes >= 3 ? `${majorFixes} major fixes planned` : null,
  ].filter(Boolean);
  if (reasons.length) {
    log(`Escalating review: ${reasons.join('; ')}`);
    const deep = await agent(
      `You are the escalation reviewer for this PR. A first-pass reviewer's assessment is below; it was escalated because: ${reasons.join('; ')}. Your assessment replaces theirs.

${situation()}
${rebaseNote()}

First-pass assessment:
${JSON.stringify(firstReview, null, 1)}

Independently re-examine the code:
- For each blocker or major finding, try to refute it by reading the code (run a focused test if that settles it). Keep it only if it survives; adjust severity, disposition, complexity, and plan as warranted.
- Investigate what the escalation names, and look for anything else the first pass missed that matters at merge time.
- Revisit thread decisions only where the first pass looks wrong; keep the thread ids.
Fixes must stay within the issue's scope and intent; everything else is a follow-up. Plans cover code and docs only, never GitHub actions.${standing} Return the complete final assessment in the same shape, with escalate=false.`,
      { ...TIER.judge, label: 'escalated review', phase: 'Review', schema: REVIEW },
    );
    if (deep) {
      review = deep;
      record.review.escalated = true;
    } else {
      record.notes.push('escalated review returned nothing; kept the first-pass assessment');
    }
  }
  record.review.alignment = review.alignment;
  record.review.issueDisposition = review.issueDisposition;
  record.review.summaryNotes = review.summaryNotes;
}

// ── Work items ───────────────────────────────────────────────────────────────────────────────

const threadInfo = {};
const rememberThreads = (threads, round) => {
  for (const t of threads) {
    threadInfo[t.id] = t;
    record.threads.push({
      id: t.id,
      title: t.title,
      verdict: t.verdict,
      action: t.action,
      severity: t.severity,
      round,
      reply: t.reply,
    });
  }
};

function itemsFrom(threads, findings) {
  const fix = [];
  const followup = [];
  for (const t of threads) {
    const item = {
      key: `thread:${t.id}`,
      source: 'review thread',
      title: t.title,
      severity: t.severity,
      complexity: t.complexity,
      plan: t.plan,
      detail: t.reply,
      files: [],
    };
    if (t.action === 'fix') fix.push(item);
    if (t.action === 'defer') followup.push(item);
  }
  for (const f of findings) {
    const item = {
      key: `finding:${f.id}`,
      source: 'merge-down review',
      title: f.title,
      severity: f.severity,
      complexity: f.complexity,
      plan: f.plan,
      detail: f.detail,
      files: f.files,
    };
    if (f.disposition === 'fix') fix.push(item);
    if (f.disposition === 'follow-up') followup.push(item);
    record.review.findings.push({
      id: f.id,
      title: f.title,
      severity: f.severity,
      disposition: f.disposition,
    });
  }
  return { fix, followup };
}

function checkItem(result, label) {
  if (result.passed) return [];
  return [
    {
      key: `check:${label}`,
      source: 'local check suite',
      title: `Local check fails${result.failedStep ? ` at "${result.failedStep}"` : ''}`,
      severity: 'major',
      complexity: SYNC.status === 'conflict' ? 'subtle' : 'mechanical',
      plan: `Read ${result.log ?? 'the check log'} and make the suite pass without weakening tests. After a rebase this usually means adapting this PR's code to changes beneath it (see upstream-delta.patch).${result.error ? ` Error: ${result.error}` : ''}`,
      detail: result.excerptFile ? `Failure excerpt: ${result.excerptFile}` : '',
      files: [],
    },
  ];
}

let work;
if (kind === 'dependency') {
  record.dependency = { decision: review.decision, rationale: review.rationale };
  record.headline = review.headline;
  if (review.decision === 'defer')
    return finish('deferred', { notes: [...record.notes, review.rationale] });
  if (review.decision === 'close') {
    if (!publishing) return finish('stopped', { plannedClose: review.closeComment });
    phase('Land');
    const closed = await clerk('close', 'Land', [step('close', 'close', '', review.closeComment)]);
    if (closed.close.error) return blocked('close', closed.close.error);
    return finish('closed');
  }
  const fixes = review.fixes.map((f) => ({
    key: `fix:${f.id}`,
    source: 'dependency review',
    title: f.title,
    severity: 'major',
    complexity: f.complexity,
    plan: f.plan,
    detail: '',
    files: [],
  }));
  work = { fix: [...fixes, ...checkItem(check0, 'check-0')], followup: [] };
} else {
  rememberThreads(review.threads, 0);
  const found = itemsFrom(review.threads, review.findings);
  work = { fix: [...found.fix, ...checkItem(check0, 'check-0')], followup: found.followup };
}
log(`Plan: ${work.fix.length} fix item(s), ${work.followup.length} follow-up(s)`);
if (A.until === 'review') return finish('stopped', { review, check: check0, plannedWork: work });

// ── Fix (∥ follow-up filing) ────────────────────────────────────────────────────────────────

let fixRound = 0;
async function implement(items) {
  fixRound++;
  const hard =
    kind === 'change' && items.some((i) => i.complexity === 'subtle' || i.severity === 'blocker');
  const tier = hard ? TIER.surgeon : TIER.mechanic;
  const label = `fix-${fixRound}`;
  const run = (t, extra) =>
    agent(
      `You implement review decisions on this PR before it merges.

${situation()}
${guidance}
${standing}
Items (each has a reviewer's plan; you own the implementation: if a plan is wrong in detail, do the right thing and say what you did instead):
${items.map((i) => `- [${i.key}] (${i.severity}; from ${i.source}) ${i.title}\n  Plan: ${i.plan}${i.detail && i.source === 'local check suite' ? `\n  ${i.detail}` : ''}`).join('\n')}
${extra}
Rules:
- Stay within this PR's scope. Do not refactor unrelated code or reformat untouched files.
- Add or update tests for behavior changes, and keep docs and skill text consistent with code changes.
- Never write to GitHub (no comments, issues, reviews, or PR edits), even if a plan asks: the workflow publishes. Mention anything that should be communicated in notes.
- Commit on the current local branch in small logical commits with concise imperative messages. No new branches, no amending or rewriting existing commits, no push.
- Before checking, format and lint what you touched: \`cd ${sh(W)} && npx prettier --write <files> && npx eslint --fix <files>\`.
- Then run \`node ${sh(TOOL)} check --pr ${A.pr} --root ${sh(ROOT)} --label ${label}\` (a few minutes; prints JSON with passed, failedStep, and the log path). If it fails, fix and re-run, at most 3 runs. Never weaken or skip tests to get green.
- Finally run \`node ${sh(TOOL)} snapshot --pr ${A.pr} --root ${sh(ROOT)}\`.
Return one entry per item key: status (fixed | partly | not-fixed), the short SHA of the commit that addresses it ('' if none), and a one-sentence summary. Also return checkPassed (from your last check run), head (from snapshot), and notes (deviations from plans, anything a reviewer should know). Write plain text (no HTML entities) and keep each summary to one sentence.`,
      { ...t, label, phase: 'Fix', schema: FIX },
    );
  let result = await run(tier, '');
  if (!result) {
    // An implementer that ends without reporting may still have committed work; don't redo it.
    log(`${label}: implementer ended without a result; retrying once`);
    result = await run(
      tier,
      `\nA previous attempt at these items ended without reporting. It may have committed some of them: check \`git -C ${sh(W)} log --oneline origin/${DEF}..HEAD\` and \`git -C ${sh(W)} status\`, keep what is correct, finish the rest, and report every item (with the commit that addresses it, even if an earlier attempt made it).`,
    );
  }
  if (result && !result.checkPassed && tier === TIER.mechanic) {
    log(`${label}: checks still failing after the mechanic; escalating to the surgeon tier`);
    result = await run(
      TIER.surgeon,
      `\nA previous attempt (notes: ${JSON.stringify(result.notes)}) left the check suite failing; see the newest ${label}.log in ${DIR}. Finish the job.`,
    );
  }
  return result;
}

async function fileFollowups(items) {
  const epic = record.followupEpic;
  const filed = await agent(
    `You file follow-up GitHub issues for problems found while merging down PR #${A.pr} ("${PR.title}"${ISSUE ? `, issue #${ISSUE.number}` : ''}) in ${REPO}. The analysis is done; your job is to write each item up well and file it.

Epic: ${epic ? `#${epic}. Attach every new issue as its sub-issue.` : `none yet. First create it with title "${A.followupEpicTitle}" and a body with a two-sentence summary (it collects follow-ups found while merging down ${A.parentEpic ? `the #${A.parentEpic} stack` : 'a PR stack'}), an "## Items" heading followed by an empty checklist, and the line "_Created by the merge-down-pr workflow._". Then attach every new issue as its sub-issue.`}

For each item:
1. Look for a duplicate first: \`gh issue list -R ${REPO} --state open --search "<keywords>"\`. If an open issue already covers it, comment there with the new evidence (mention PR #${A.pr}) and report action commented-existing.
2. Otherwise create it in the style of the existing epic children (\`gh issue view 47 -R ${REPO}\` is a good model): "## Summary" (2–4 sentences: the problem and the proposal), "## Problem" (concrete, with path:line references as of PR #${A.pr}), "## Proposal", "## Acceptance criteria" (checkboxes), "## Related" (PR #${A.pr}${ISSUE ? `, #${ISSUE.number}` : ''}, and other related issues you know of), ending with "_Part of #EPIC. Found while merging down #${A.pr}._". Choose one label: bug, enhancement, or documentation. Create with \`gh issue create -R ${REPO} --title … --label … --body-file <file>\`, writing the body file with a quoted heredoc.
3. Attach it: \`gh api -X POST repos/${REPO}/issues/EPIC/sub_issues -F sub_issue_id=$(gh api repos/${REPO}/issues/NEW --jq .id)\`, then append "- [ ] #NEW <title>" to the epic body's Items checklist (\`gh issue view EPIC --json body\`, edit, \`gh issue edit EPIC -R ${REPO} --body-file …\`).

The PR's code is in the worktree ${W}; read it only as needed to make references accurate.

Items:
${items.map((i) => `### [${i.key}] ${i.title}\nSeverity: ${i.severity}. Source: ${i.source}.\n${i.detail}\nSuggested direction: ${i.plan}${i.files?.length ? `\nFiles: ${i.files.join(', ')}` : ''}`).join('\n\n')}

Return the epic (number, url, created) and one entry per item key.`,
    { ...TIER.scribe, label: 'file follow-ups', phase: 'Fix', schema: FILED },
  );
  if (filed?.epic?.number) record.followupEpic = filed.epic.number;
  // Scribes sometimes drop the "finding:"/"thread:" prefix from an item key ("F4" for
  // "finding:F4"). Map a returned key back to the one item it names, so a filed issue is not
  // counted as unfiled.
  const keys = items.map((i) => i.key);
  for (const f of filed?.issues ?? []) {
    if (keys.includes(f.key)) continue;
    const match = keys.filter((k) => k.endsWith(`:${f.key}`));
    if (match.length === 1) f.key = match[0];
  }
  for (const f of filed?.issues ?? [])
    record.followups.push({
      key: f.key,
      number: f.number,
      url: f.url,
      title: f.title,
      action: f.action,
    });
  return filed;
}

function replyFor(t, fixed, filed) {
  let body = t.reply.trim();
  if (t.action === 'fix') {
    const done = fixed?.items?.find((i) => i.key === `thread:${t.id}`);
    if (!done || done.status === 'not-fixed') return null;
    body += `\n\nAddressed in ${done.commit}${done.summary ? `: ${done.summary}` : '.'}`;
  }
  if (t.action === 'defer') {
    const issue = filed?.issues?.find((i) => i.key === `thread:${t.id}`);
    if (issue) body += `\n\nTracked in #${issue.number}.`;
  }
  // A rejected code-scanning thread also dismisses its alert (merge-down.mjs picks the reason).
  // A settled code-scanning alert must leave the open set: rejected ones are dismissed as false
  // positives, deferred ones as "won't fix" pointing at the follow-up (merge-down.mjs decides).
  const dismiss = t.action === 'reject' ? 'reject' : t.action === 'defer' ? 'defer' : null;
  return { threadId: t.id, body, ...(dismiss ? { dismiss } : {}) };
}

// Returns {replies, changed} or a blocked record.
async function fixRoundOf(threads, work) {
  if (!work.fix.length && !work.followup.length) {
    return { replies: threads.map((t) => replyFor(t, null, null)).filter(Boolean), changed: false };
  }
  phase('Fix');
  const [fixed, filed] = await parallel([
    async () => (work.fix.length ? implement(work.fix) : null),
    async () => (work.followup.length && publishing ? fileFollowups(work.followup) : null),
  ]);
  if (work.fix.length && !fixed) return { error: 'implementer returned nothing' };
  // An omitted item is not a fixed item: own findings and check repairs have no thread to resurface.
  const reported = new Set((fixed?.items ?? []).map((i) => i.key));
  const unreported = work.fix.filter((i) => !reported.has(i.key)).map((i) => i.key);
  if (unreported.length) return { error: `implementer did not report: ${unreported.join(', ')}` };
  if (work.followup.length && publishing) {
    const filedKeys = new Set((filed?.issues ?? []).map((i) => i.key));
    const unfiled = work.followup.filter((i) => !filedKeys.has(i.key)).map((i) => i.key);
    if (!filed || unfiled.length) {
      return { error: `follow-up filing incomplete: ${unfiled.join(', ') || 'no result'}` };
    }
  }
  // "partly" is unfinished, and "fixed" needs the commit that did it: otherwise the thread would
  // be called addressed and resolved without any change behind it.
  const unfixed = (fixed?.items ?? []).filter((i) => i.status !== 'fixed' || !i.commit?.trim());
  if (unfixed.length)
    return { error: `could not fix: ${unfixed.map((i) => `${i.key} (${i.summary})`).join('; ')}` };
  if (fixed && !fixed.checkPassed)
    return { error: `local checks still fail after fixes: ${fixed.notes.join('; ')}` };
  if (fixed) {
    // Don't take the implementer's word: its commits must be in the branch, and the last check
    // must have passed against the head we are about to publish.
    const commits = [...new Set(fixed.items.map((i) => i.commit.trim()).filter(Boolean))].join(',');
    const verified = (
      await clerk(`verify ${`fix-${fixRound}`}`, 'Fix', [
        step('verify', 'verify-fixes', commits ? `--commits ${commits}` : ''),
      ])
    ).verify;
    if (verified.error) return { error: `could not verify fixes: ${verified.error}` };
    if (verified.missingCommits.length) {
      return { error: `reported commits not in the branch: ${verified.missingCommits.join(', ')}` };
    }
    if (!verified.checkPassedAtHead) {
      return { error: `no passing check recorded for head ${verified.head.slice(0, 7)}` };
    }
  }
  if (fixed?.notes?.length) record.fixNotes = [...(record.fixNotes ?? []), ...fixed.notes];
  record.fixes = [...(record.fixes ?? []), ...(fixed?.items ?? [])];
  const replies = threads.map((t) => replyFor(t, fixed, filed)).filter(Boolean);
  const changed = (fixed?.items ?? []).some((i) => i.status !== 'not-fixed' && i.commit);
  return { replies, changed };
}

const initialThreads = kind === 'change' ? review.threads : [];
const firstRound = await fixRoundOf(initialThreads, work);
if (firstRound.error) return blocked('fix', firstRound.error);
if (A.until === 'fix') return finish('stopped', { review, plannedReplies: firstRound.replies });

// ── Gate: publish, reply, request Codex, wait; loop on new findings or red CI ────────────────

const codexAllowed = kind === 'change' && A.codex !== 'never';
const ownCodeChanged = SYNC.status === 'conflict' || firstRound.changed;
let wantCodex = codexAllowed && (A.codex === 'always' || ownCodeChanged || !PR.codex.reviewed);
const closesIssue = kind === 'change' && ISSUE && review.issueDisposition.action === 'close';
// A PR body that says "Closes #N" would close an issue the review decided to keep open.
const keepsIssueOpen = kind === 'change' && ISSUE && review.issueDisposition.action === 'keep-open';
let replies = firstRound.replies;
const rerunHeads = [];
let head = null;
let codexRequests = 0;

const AWAIT_LOOP = (
  listing,
) => `Run this command with the Bash tool (timeout 600000 ms). It waits up to 9 minutes and prints one line of JSON.

${listing}

If that JSON contains "done":false, run the exact same command again; repeat until "done" is true or you have run it 4 times. Do nothing else.

${RELAY_RULES} The only id is "await": relay the output of the last run.`;

async function waitForGate(sha, since, codex) {
  const flags = `--sha ${sha} --since ${since} --codex ${codex ? 'required' : 'skip'} --max-seconds 540`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const label = `await r${record.rounds}.${attempt}`;
    const gate = (await clerk(label, 'Gate', [step('await', 'await', flags)], AWAIT_LOOP)).await;
    if (gate.done || gate.error) return gate;
  }
  return { done: false, timedOut: true };
}

while (true) {
  record.rounds++;
  if (record.rounds > A.codexRoundsHardCap + 3) {
    return blocked('gate', `still unsettled after ${record.rounds - 1} review rounds`);
  }
  phase('Gate');
  const commands = [
    step(
      'publish',
      'publish',
      closesIssue
        ? `--ensure-closes ${ISSUE.number}`
        : keepsIssueOpen
          ? `--keep-open ${ISSUE.number}`
          : '',
    ),
  ];
  if (replies.length) commands.push(step('reply', 'reply', '', JSON.stringify(replies, null, 1)));
  if (wantCodex) commands.push(step('review', 'request-review'));
  const pub = await clerk(`publish r${record.rounds}`, 'Gate', commands);
  if (pub.publish.error) return blocked('publish', pub.publish.error);
  if (replies.length && (pub.reply.error || pub.reply.failures)) {
    record.notes.push(`thread replies: ${pub.reply.error ?? `${pub.reply.failures} failed`}`);
  }
  if (wantCodex && pub.review.error)
    return blocked('publish', `could not request a Codex review: ${pub.review.error}`);
  if (closesIssue && pub.publish.linked === false)
    record.notes.push(`issue #${ISSUE.number} is not linked as closing; land will verify`);
  head = pub.publish.head;
  if (wantCodex) codexRequests++;
  record.codexReviewsRequested = codexRequests;
  replies = [];

  const gate = await waitForGate(head, wantCodex ? pub.review.since : pub.publish.at, wantCodex);
  if (!gate || gate.error) return blocked('gate', gate?.error ?? 'waiting produced no output');
  if (gate.headMoved)
    return blocked('gate', `PR head moved to ${gate.headSha} while waiting; someone else pushed`);
  if (!gate.done)
    return blocked(
      'gate',
      `timed out waiting (CI ${gate.ci?.state ?? '?'}, Codex ${gate.codex?.state ?? '?'})`,
    );
  log(`Round ${record.rounds}: CI ${gate.ci.state}; Codex ${gate.codex.state}`);

  let ciFailed = gate.ci.state === 'failure';
  if (gate.codex.state === 'error')
    record.notes.push(`Codex review errored in round ${record.rounds}; proceeding on CI`);
  const codexFindings = wantCodex && gate.codex.state === 'findings';
  // Anything else unanswered: code-scanning (CodeQL) threads or alerts, other bots, humans.
  const attention = (gate.attention?.untriagedThreads ?? 0) + (gate.attention?.openAlerts ?? 0);
  let needsTriage = codexFindings || attention > 0;
  if (attention && !codexFindings) {
    log(`Round ${record.rounds}: ${attention} unanswered thread(s)/alert(s) need triage`);
  }
  if (ciFailed && !needsTriage && !rerunHeads.includes(head)) {
    // Red CI on a head we are not about to replace: re-run the failed jobs once before paying an
    // agent to "fix" what may be a flake in code this PR never touched.
    rerunHeads.push(head);
    const rerun = await clerk(`rerun CI r${record.rounds}`, 'Gate', [
      step('rerun', 'rerun', `--sha ${head}`),
    ]);
    if (!rerun.rerun.error && rerun.rerun.rerun.length) {
      const again = await waitForGate(head, pub.publish.at, false);
      if (!again || again.error || again.headMoved || !again.done) {
        return blocked('gate', again?.error ?? 'waiting for re-run CI failed');
      }
      const flaky = again.ci.state === 'success';
      record.notes.push(
        `CI failed on ${gate.ci.failed.join(', ')}; re-ran the failed jobs: ${flaky ? 'passed (flaky)' : 'failed again'}`,
      );
      if (flaky) {
        record.flakyChecks = [...(record.flakyChecks ?? []), ...gate.ci.failed];
        ciFailed = false;
      } else {
        gate.ci = again.ci;
      }
      // Threads can arrive while the re-run is pending.
      const lateAttention =
        (again.attention?.untriagedThreads ?? 0) + (again.attention?.openAlerts ?? 0);
      if (lateAttention) {
        needsTriage = true;
        log(
          `Round ${record.rounds}: ${lateAttention} thread(s)/alert(s) arrived during the CI re-run`,
        );
      }
    }
  }
  if (!ciFailed && !needsTriage) break;

  let threads = [];
  const roundWork = { fix: [], followup: [] };
  if (needsTriage) {
    phase('Review');
    const settled = record.threads.map((t) => `- ${t.title}: ${t.verdict}, ${t.action}`).join('\n');
    const triage = await agent(
      `${codexFindings ? `Codex re-reviewed PR #${A.pr} after our latest push and left new review threads.` : `PR #${A.pr} has review threads or code-scanning alerts that nobody has answered yet.`} Decide what to do with each one.

${situation()}

Read ${DIR}/threads.md (every unresolved thread; it was just refreshed) and the code each thread points at.
Decisions already made on this PR, for consistency (don't reopen them unless a new thread shows they were wrong):
${settled || '- none'}

For each unresolved thread: verdict (valid | partly-valid | invalid | obsolete), action (fix | defer | reject | none), severity, complexity (mechanical | subtle), plan, and a 1–3 sentence reply to post (the workflow appends the fixing commit or follow-up issue). A fix must stay within this PR's issue scope; otherwise defer${PR.laterInStack ? ', or reject with "addressed by #N" when a later PR in stack.md covers it' : ''}. This is Codex round ${codexRequests}; re-reviews stop after round ${A.maxCodexRounds} unless a round keeps finding real major problems (hard cap ${A.codexRoundsHardCap}), so be decisive and rate severity honestly. Use the thread ids exactly as in threads.md, including alert:N for code-scanning alerts that have no review thread. Plans cover code and docs only, never GitHub actions.
Threads by github-advanced-security are CodeQL code-scanning alerts (threads.md also lists every open alert on the PR). Fix real problems, and prefer a cheap safer pattern over arguing when one exists (for example, pass values to generated scripts through argv or env instead of interpolating them into code). Reject only a genuine false positive or test-only pattern, with a short justification; the workflow dismisses the alert using your reply. Defer an alert only as an accepted risk with a follow-up: it is then dismissed as "won't fix".${standing}`,
      { ...TIER.reviewer, label: `triage r${record.rounds}`, phase: 'Review', schema: TRIAGE },
    );
    if (!triage) return blocked('review', 'thread triage returned nothing');
    threads = triage.threads;
    rememberThreads(threads, record.rounds);
    if (triage.notes?.length) record.triageNotes = [...(record.triageNotes ?? []), ...triage.notes];
    const found = itemsFrom(threads, []);
    roundWork.fix.push(...found.fix);
    roundWork.followup.push(...found.followup);
  }
  if (ciFailed) {
    record.ciRepairs++;
    if (record.ciRepairs > A.maxCiRepairs)
      return blocked(
        'gate',
        `CI still failing after ${A.maxCiRepairs} repair attempts: ${gate.ci.failed.join(', ')}`,
      );
    roundWork.fix.push({
      key: `ci:${record.rounds}`,
      source: 'GitHub CI',
      title: `CI failed: ${gate.ci.failed.join(', ')}`,
      severity: 'major',
      complexity: 'mechanical',
      plan: `Diagnose with \`gh pr checks ${A.pr} -R ${REPO}\` and \`gh run view <run-id> -R ${REPO} --log-failed\`, reproduce locally if possible (CI runs Node 22.13, 24, and 26), and fix the cause.${rerunHeads.includes(head) ? ' The failure survived one re-run of the failed jobs.' : ''} If the failing code is outside this PR's changes, make the narrowest fix and say so in notes.`,
      detail: '',
      files: [],
    });
  }
  const next = await fixRoundOf(threads, roundWork);
  if (next.error) return blocked('fix', next.error);
  replies = next.replies;
  // Codex reports a few findings per pass, so intricate PRs show a long tail of real,
  // pre-existing problems rather than churn. Past the base limit, keep asking only while the
  // latest round still found something major.
  const latestMajor = threads.some(
    (t) =>
      ['major', 'blocker'].includes(t.severity) && ['valid', 'partly-valid'].includes(t.verdict),
  );
  const underLimit =
    codexRequests < A.maxCodexRounds || (latestMajor && codexRequests < A.codexRoundsHardCap);
  wantCodex = codexAllowed && next.changed && underLimit;
  if (codexRequests >= A.maxCodexRounds && wantCodex) {
    record.notes.push(
      `Codex round ${codexRequests} found a major problem; requesting another review`,
    );
  }
  if (codexFindings && next.changed && !wantCodex) {
    record.notes.push(
      latestMajor
        ? `Codex hard cap (${A.codexRoundsHardCap}) reached with a major finding in the last round; its fixes were gated on CI only`
        : `Codex round limit reached after round ${codexRequests} (latest findings minor); the last fixes were gated on CI only`,
    );
  }
  // Triage that changed nothing still has replies to publish, and the failed jobs deserve their
  // one re-run on this head before anyone concludes the failure is real.
  if (ciFailed && !next.changed && rerunHeads.includes(head)) {
    return blocked('gate', 'CI failed and the repair made no changes');
  }
}

// ── Land ─────────────────────────────────────────────────────────────────────────────────────

phase('Land');
const issueFlags =
  kind === 'change' && ISSUE
    ? ` --issue ${ISSUE.number}${closesIssue ? ' --expect-close' : keepsIssueOpen ? ` --keep-open ${ISSUE.number}` : ''}`
    : '';
const landed = await clerk('land', 'Land', [step('land', 'land', `--sha ${head}${issueFlags}`)]);
const L = landed.land;
if (L.error) return blocked('land', L.error);
if (!L.merged) return blocked('land', L.reason ?? 'merge did not happen');
record.mergeCommit = L.mergeCommit;
record.children = L.children;
if (L.issue && record.issue) {
  record.issue.state = L.issue.state;
  record.issue.closedManually = L.issue.closedManually;
  if (L.issue.closedManually)
    record.notes.push(`issue #${ISSUE.number} did not auto-close; closed explicitly`);
}
log(`Merged #${A.pr} as ${String(L.mergeCommit).slice(0, 7)}`);

// ── Report ───────────────────────────────────────────────────────────────────────────────────

if (kind === 'change' && ISSUE) {
  phase('Report');
  const facts = {
    pr: { number: A.pr, title: PR.title, mergeCommit: L.mergeCommit },
    issue: {
      number: ISSUE.number,
      disposition: review.issueDisposition,
      stateAfterMerge: record.issue.state,
    },
    rebase: record.rebase,
    alignment: review.alignment,
    threads: record.threads,
    fixes: record.fixes ?? [],
    findings: record.review.findings,
    followups: record.followups,
    summaryNotes: review.summaryNotes,
    escalatedReview: record.review.escalated,
    codexReviewsRequested: codexRequests,
    notes: record.notes,
  };
  const report = await agent(
    `Write and post the closing summary for issue #${ISSUE.number} in ${REPO}. PR #${A.pr} "${PR.title}" has just been squash-merged into ${DEF} as ${String(L.mergeCommit).slice(0, 7)}.

Facts from the merge-down workflow (the source of truth; don't re-investigate the code):
${JSON.stringify(facts, null, 1)}

Post a comment on #${ISSUE.number} only if it records something a future reader could not see from the PR itself: fixes made during merge-down (review-thread or our own findings, semantic-rebase adaptations), feedback rejected and why, gaps or deviations versus the issue, follow-ups filed, what remains if the issue stays open, and the summary notes. If none of that exists, don't post.
Style: one lead sentence, then short bullets. Reference PRs and issues as #123 and commits by short SHA. No headings unless it runs long; no boilerplate or praise. Post with \`gh issue comment ${ISSUE.number} -R ${REPO} --body-file <file>\` (write the file with a quoted heredoc); gh prints the comment URL.
Also write headline: 1–2 plain sentences for a ledger of the whole merge-down, saying what happened with this PR.
Return posted, commentUrl ('' if not posted), and headline.`,
    { ...TIER.scribe, label: 'issue summary', phase: 'Report', schema: REPORT },
  );
  record.summaryCommentUrl = report?.posted ? report.commentUrl : null;
  record.headline = report?.headline ?? null;
}
if (kind === 'dependency' && (record.fixes ?? []).length) {
  const fixes = record.fixes.map((f) => f.summary).join(' ');
  record.headline = `${record.headline ?? ''} During merge-down: ${fixes}`.trim();
}
if (!record.headline && kind === 'change') {
  // No issue, so no scribe: build the ledger line from the review and the gate.
  const fixedCount = (record.fixes ?? []).filter((f) => f.status !== 'not-fixed').length;
  const lead = review.summaryNotes?.[0] ?? review.alignment?.notes?.split('. ')[0] ?? '';
  const outcome = [
    fixedCount ? `${fixedCount} fix(es) during merge-down` : 'no changes needed',
    record.threads.length ? `${record.threads.length} review thread(s) triaged` : null,
    codexRequests
      ? `Codex re-review ${record.threads.some((t) => t.round > 0) ? 'raised findings that were handled' : 'clean'}`
      : null,
  ].filter(Boolean);
  record.headline =
    `${lead}${lead && !lead.endsWith('.') ? '.' : ''} Merged with ${outcome.join('; ')}.`.trim();
}
if (!record.headline) {
  const fixedCount = (record.fixes ?? []).filter((f) => f.status !== 'not-fixed').length;
  record.headline = `Merged${fixedCount ? ` after ${fixedCount} fix(es)` : ' as-is'}${record.threads.length ? `; ${record.threads.length} review thread(s) triaged` : ''}.`;
}
record.agents = { clerkRuns };
return finish('merged');
