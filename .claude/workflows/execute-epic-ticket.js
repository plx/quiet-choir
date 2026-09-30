export const meta = {
  name: 'execute-epic-ticket',
  description:
    'Find and execute one ticket from an epic: pick the next ready ticket, check it is still valid and plan it, implement it in a dedicated worktree, open a PR, land it via merge-down-pr, tick the epic — or report the epic done, stalled, or waiting on a decision',
  whenToUse:
    'Burning down an epic one ticket per run, in the order its checklist gives. Args: {epic, ticket?, decision?, until?, followupEpic?, standingNotes?}.',
  phases: [
    { title: 'Survey', detail: 'snapshot the epic and pick the next ticket (haiku)' },
    { title: 'Plan', detail: 'readiness check and implementation plan (opus high)' },
    {
      title: 'Implement',
      detail: 'implement and pass local checks in the dedicated worktree (sonnet or opus high)',
    },
    {
      title: 'Publish',
      detail: 'PR description ∥ follow-ups (sonnet), open the PR, await the first Codex review',
    },
    { title: 'Land', detail: 'merge-down-pr as an inline child workflow' },
    { title: 'Report', detail: 'tick the epic, append the ledger, re-survey (haiku)' },
  ],
};

/*
 * execute-epic-ticket — find the next ticket in an epic and carry it all the way to main.
 *
 * WHAT IT DOES
 *   1. Survey     Snapshot the epic: its checklist order, sub-issues, each ticket's state, declared
 *                 dependencies ("Depends on #N", GitHub's blocked-by links), hold labels, and any
 *                 open PR that already closes a ticket. Pick the next ticket deterministically:
 *                 in-flight work (an open PR) first, then a split parent whose slices are all done,
 *                 then the first ready ticket in checklist order.
 *   2. Plan       One strong reader checks the ticket against the current code and decides:
 *                 ready (and writes the implementation plan), obsolete (already done or no longer
 *                 applies; an independent skeptic must agree before anything is closed),
 *                 needs-decision (a question only the maintainer can answer; posted on the issue
 *                 with the needs-decision label), blocked (by an undeclared dependency; recorded
 *                 as "Depends on #N" and the next candidate is tried), or split (too large for one
 *                 reviewable PR; slices are filed as epic items right after it).
 *   3. Implement  An implementer (model chosen by the plan's complexity) works in a dedicated
 *                 worktree on the ticket's branch, commits, and runs the full local check suite.
 *                 Its report is verified mechanically: every commit it names is on the branch,
 *                 the worktree is clean, and a check passed at the exact head.
 *   4. Publish    A scribe writes the PR description while another files out-of-scope follow-ups
 *                 under the follow-up epic. The helper opens the PR (only for a verified, green
 *                 head) and the workflow waits for Codex's automatic first review, so the landing
 *                 review can triage it in its first pass.
 *   5. Land       merge-down-pr runs as an inline child workflow: review against the issue, thread
 *                 triage and fixes, CI + Codex + CodeQL gate, squash-merge, issue summary.
 *   6. Report     Tick the ticket in the epic's checklist, append the ledger, re-survey, and return
 *                 a record with the next ticket and what remains.
 *
 * INVOCATION
 *   Workflow({ name: 'execute-epic-ticket', args: { epic: 99, followupEpic: 140 } })
 *   args.epic            required; the epic issue whose checklist/sub-issues are the tickets
 *   args.ticket          work on this ticket instead of the survey's choice
 *   args.decision        the maintainer's answer to a needs-decision question on args.ticket; it is
 *                        posted on the issue (removing the label) before planning
 *   args.until           'survey' | 'plan' | 'implement' | 'pr' | 'land' (default). 'survey' and
 *                        'plan' change nothing; 'implement' commits only to the local branch;
 *                        'pr' publishes the PR and stops before landing
 *   args.followupEpic    epic for follow-ups found along the way; if absent, one titled
 *   args.followupEpicTitle  (default 'Epic: enhancements, wave 3') is found or created on first need.
 *                        The result's followupEpic carries the number to pass to later runs
 *   args.standingNotes   decisions that every planner, implementer and landing reviewer should
 *                        apply without re-litigating (array of strings)
 *   args.maxCandidates   tickets to try in one run when earlier ones turn out blocked (default 3)
 *   args.implementer     'auto' (default) | 'mechanic' | 'surgeon' — override the plan's tiering
 *   args.mergeDown       extra args for the merge-down-pr child (e.g. {maxCodexRounds: 2})
 *   args.commitTrailer   lines to end every commit message with (e.g. Co-Authored-By)
 *   args.prFooter        text to end the PR description with
 *   args.root            directory holding worktree/ and state/ (default: <main checkout>-epic-burndown)
 *   args.mergeDownScript absolute path of merge-down-pr.js to run as the landing child (default:
 *                        the registered 'merge-down-pr'; pass the path when iterating on the child)
 *
 * OUTCOMES (record.status)
 *   landed           the ticket's PR merged and the issue closed; epic ticked
 *   pr-open          until: 'pr' — the PR is open and has had its first Codex review
 *   closed-obsolete  the ticket was already done / no longer applies; closed with the evidence
 *   closed-split     a split ticket whose slices have all closed; closed and ticked
 *   needs-decision   a question for the maintainer (record.decision); rerun with args.ticket +
 *                    args.decision once answered
 *   split            the ticket was split into slices (record.slices); the next run takes slice 1
 *   held             args.ticket names a ticket with a hold label and no decision was given
 *   epic-done        no open tickets remain (closing the epic is left to the maintainer)
 *   stalled          open tickets remain but none is ready (waiting on dependencies, held, split)
 *   blocked          a stage could not finish (record.blocked.stage/reason); re-running is safe
 *   stopped          an `until` short of 'land' was reached
 *
 * INVARIANTS
 *   - One ticket per run. The implementation happens in the dedicated worktree; the invoking
 *     checkout is never touched. Nothing is published before `until` allows it.
 *   - Nothing unverified is published: the PR opens only for a clean head that passed the full
 *     local check suite (the helper enforces this, not the prompt). Obsolete tickets are closed only
 *     when an independent skeptic agrees.
 *   - Re-running is safe. A ticket with an open PR resumes at landing; a branch from an interrupted
 *     run is reused (the planner re-validates it); every GitHub write in the helper is idempotent.
 *   - Follow-ups never grow the epic being burned down: they go to the follow-up epic.
 *
 * MODEL TIERS (spend judgment only where judgment is needed)
 *   clerk     haiku  / low     run epic.mjs / merge-down.mjs subcommands and relay their JSON
 *   scribe    sonnet / medium  PR descriptions, follow-up and slice write-ups
 *   mechanic  sonnet / high    mechanical implementation
 *   planner   opus   / high    readiness and the implementation plan (reads the ticket and code once)
 *   skeptic   opus   / medium  confirms an "obsolete" verdict before a ticket is closed
 *   surgeon   opus   / high    subtle implementation; escalation when the mechanic fails checks
 *   (landing runs merge-down-pr with its own tiers)
 *
 * PORTING NOTES (this file is a design reference for quiet-choir; see the README for the full map)
 *   - Every clerk call is a deterministic effect that only needs an agent because a Claude Code
 *     workflow cannot run commands; in quiet-choir each becomes ctx.exec.json with no model cost.
 *   - needs-decision is a return-and-rerun here; in quiet-choir it is ctx.ask: the run suspends
 *     (exit 75), the answer is validated against a schema, and resume continues in place.
 *   - The Codex wait is a bounded relay loop here; in quiet-choir it is ctx.poll with a deadline.
 *   - The landing child is workflow('merge-down-pr'); in quiet-choir it is ctx.workflow with typed
 *     input/output, and its effects share the parent's journal.
 *   - Cross-session resumability lives in the helper's state files (plan.json, start.json, pr.json);
 *     in quiet-choir the run journal holds it.
 */

const TIER = {
  clerk: { model: 'haiku', effort: 'low' },
  scribe: { model: 'sonnet', effort: 'medium' },
  mechanic: { model: 'sonnet', effort: 'high' },
  planner: { model: 'opus', effort: 'high' },
  skeptic: { model: 'opus', effort: 'medium' },
  surgeon: { model: 'opus', effort: 'high' },
};

const UNTIL = ['survey', 'plan', 'implement', 'pr', 'land'];
const A = {
  epic: Number(args?.epic),
  ticket: args?.ticket == null ? null : Number(args.ticket),
  decision:
    typeof args?.decision === 'string' && args.decision.trim() ? args.decision.trim() : null,
  until: args?.until ?? 'land',
  followupEpic: args?.followupEpic ?? null,
  followupEpicTitle: args?.followupEpicTitle ?? 'Epic: enhancements, wave 3',
  standingNotes: args?.standingNotes ?? [],
  maxCandidates: args?.maxCandidates ?? 3,
  implementer: args?.implementer ?? 'auto',
  mergeDown: args?.mergeDown ?? {},
  commitTrailer: args?.commitTrailer ?? '',
  prFooter: args?.prFooter ?? '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  root: args?.root ?? null,
  tools: args?.tools ?? '.claude/workflows/execute-epic-ticket/epic.mjs',
  mergeDownTools: args?.mergeDownTools ?? '.claude/workflows/merge-down-pr/merge-down.mjs',
  // Absolute path of merge-down-pr.js. By name, the child comes from the workflow registry, and a
  // resume with unchanged parent code and args may not pick up edits to the child.
  mergeDownScript: args?.mergeDownScript ?? null,
};
if (!Number.isInteger(A.epic) || A.epic <= 0) {
  return { status: 'error', reason: 'args.epic (an issue number) is required' };
}
if (A.ticket !== null && (!Number.isInteger(A.ticket) || A.ticket <= 0)) {
  return { status: 'error', reason: 'args.ticket must be an issue number' };
}
if (A.decision && A.ticket === null) {
  return { status: 'error', reason: 'args.decision needs args.ticket (the ticket it answers)' };
}
if (!UNTIL.includes(A.until)) {
  return { status: 'error', reason: `args.until must be one of ${UNTIL.join(', ')}` };
}
if (!['auto', 'mechanic', 'surgeon'].includes(A.implementer)) {
  return { status: 'error', reason: "args.implementer must be 'auto', 'mechanic' or 'surgeon'" };
}
const reach = (stage) => UNTIL.indexOf(A.until) >= UNTIL.indexOf(stage);
// GitHub writes (comments, labels, closes, filings, PRs, merges) start at 'pr'.
const publishing = reach('pr');

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

// Every field is required so the model always states it; "not applicable" is '' or [].
const PLAN = obj({
  readiness: oneOf('ready', 'obsolete', 'needs-decision', 'blocked', 'split'),
  rationale: str,
  issueComment: str,
  obsoleteKind: oneOf('already-done', 'no-longer-applies', 'n/a'),
  decision: obj({
    question: str,
    options: arr(obj({ label: str, consequence: str })),
    recommendation: str,
  }),
  blockedBy: arr(num),
  slices: arr(obj({ title: str, summary: str, acceptance: arr(str), dependsOnPrevious: bool })),
  plan: obj({
    title: str,
    approach: str,
    steps: arr(obj({ id: str, description: str, files: arr(str) })),
    acceptance: arr(obj({ id: str, criterion: str, how: str })),
    tests: arr(str),
    docs: arr(str),
    risks: arr(str),
    outOfScope: arr(str),
    complexity: oneOf('mechanical', 'subtle'),
    size: oneOf('small', 'medium', 'large'),
  }),
});
const SKEPTIC = obj({ agree: bool, evidence: str, remaining: arr(str) });
// Reports must name the items they were given: ids and keys are constrained to those values, so a
// mistyped id is a schema retry rather than an unreported criterion.
const IMPLEMENTED = (ids) =>
  obj({
    criteria: arr(
      obj({
        id: oneOf(...ids),
        status: oneOf('done', 'verify-on-pr', 'partial', 'not-done'),
        commit: str,
        evidence: str,
      }),
    ),
    checkPassed: bool,
    head: str,
    deviations: arr(str),
    followups: arr(obj({ title: str, detail: str })),
    notes: arr(str),
  });
const PR_TEXT = obj({ title: str, body: str });
const WRITEUPS = (keys) =>
  obj({
    issues: arr(
      obj({
        key: oneOf(...keys),
        duplicateOf: num,
        title: str,
        label: oneOf('bug', 'enhancement', 'documentation'),
        body: str,
      }),
    ),
  });

// ── Run state ────────────────────────────────────────────────────────────────────────────────

const record = {
  epic: A.epic,
  status: 'running',
  ticket: null,
  pr: null,
  plan: null,
  implementer: null,
  landing: null,
  followups: [],
  followupEpic: A.followupEpic,
  slices: [],
  decision: null,
  skipped: [],
  remaining: null,
  next: null,
  headline: null,
  notes: [],
  blocked: null,
};
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

// ── Verified relay (same protocol as merge-down-pr.js) ─────────────────────────────────────────
// A Claude Code workflow cannot run commands, so a haiku clerk runs each helper subcommand and
// copies its one-line JSON into its final message. Each output carries the caller's nonce and an
// FNV-1a hash of everything else; a copy that fails verification is re-read from the helper's
// saved output (`last`) instead of repeating the effect.

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

const sh = (value) =>
  /^[\w@%+=:,./-]+$/.test(String(value))
    ? String(value)
    : `'${String(value).replace(/'/g, `'\\''`)}'`;

let TOOL = A.tools;
let ROOT = A.root;
let nonceSeq = 0;
let clerkRuns = 0;

// One epic.mjs invocation. `issue` scopes the saved output (and `last`) to that ticket; `epic`
// defaults to the epic being burned down (follow-ups are filed under a different one).
function cmd(id, sub, { epic = A.epic, issue = null, flags = '', stdin = null } = {}) {
  const nonce = `n${++nonceSeq}`;
  const scope = `--epic ${epic}${issue ? ` --issue ${issue}` : ''}${ROOT ? ` --root ${sh(ROOT)}` : ''}`;
  const base = `node ${sh(TOOL)} ${sub} ${scope} --nonce ${nonce}${flags ? ` ${flags}` : ''}`;
  return {
    id,
    sub,
    nonce,
    run: stdin === null ? base : `${base} <<'EPIC_EOF'\n${stdin}\nEPIC_EOF`,
    reread: `node ${sh(TOOL)} last ${scope} --cmd ${sub}`,
  };
}

// One merge-down.mjs invocation (landing tooling shared with merge-down-pr; its own state root).
function mdCmd(id, sub, pr, flags = '') {
  const nonce = `n${++nonceSeq}`;
  return {
    id,
    sub,
    nonce,
    run: `node ${sh(A.mergeDownTools)} ${sub} --pr ${pr} --nonce ${nonce}${flags ? ` ${flags}` : ''}`,
    reread: `node ${sh(A.mergeDownTools)} last --pr ${pr} --cmd ${sub}`,
  };
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

// Run helper steps through a clerk; returns {id: verified output}. Unverifiable outputs are
// re-read from the helper's saved copy up to twice (never re-executed), then reported as errors.
async function clerk(label, phaseName, steps, render = RUN_STEPS) {
  const first = await relay(label, phaseName, steps, render);
  const out = first.verified;
  let missing = first.missing;
  let dead = first.dead;
  for (let i = 1; i <= 2 && missing.length; i++) {
    const rereads = missing.map((s) => ({ ...s, run: s.reread }));
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

// A single helper call; returns its verified output (which may be {error}).
const one = async (label, phaseName, step) => (await clerk(label, phaseName, [step]))[step.id];

const standing = () =>
  A.standingNotes.length
    ? `\nStanding decisions for this burn-down (apply them; don't re-litigate):\n${A.standingNotes.map((n) => `- ${n}`).join('\n')}\n`
    : '';

// ── Survey ───────────────────────────────────────────────────────────────────────────────────

phase('Survey');
const survey = await one(
  `survey #${A.epic}`,
  'Survey',
  cmd('survey', 'survey', {
    flags: `--candidates ${A.maxCandidates}${A.ticket ? ` --prefer ${A.ticket}` : ''}`,
  }),
);
if (survey.error) return blocked('survey', survey.error);
const REPO = survey.repo;
const DEF = survey.defaultBranch;
if (survey.tool) TOOL = survey.tool;
record.epicTitle = survey.epic.title;
record.remaining = survey.counts;
log(
  `#${A.epic} ${survey.epic.title}: ${survey.counts.open} open of ${survey.counts.total} ` +
    `(${survey.counts.ready} ready, ${survey.counts.inFlight} in flight, ${survey.counts.waiting} waiting, ${survey.counts.held} held)`,
);
if (survey.done) {
  return finish('epic-done', {
    headline: `Epic #${A.epic} has no open tickets left; close it when ready.`,
  });
}
if (A.ticket && survey.next?.number !== A.ticket) {
  return blocked('survey', `#${A.ticket} is not an open ticket of epic #${A.epic}`);
}
if (!survey.next) {
  // survey.items lists every open item compactly: number, status, and any open dependencies.
  const waiting = survey.items.map(
    (i) =>
      `#${i.number} ${i.status}${i.openDeps?.length ? ` on ${i.openDeps.map((d) => `#${d}`).join(', ')}` : ''}`,
  );
  return finish('stalled', {
    headline: `Nothing in #${A.epic} is ready: ${waiting.join('; ')}.`,
  });
}

// Candidates for this run: the survey's pick, then later ready tickets in epic order (tried only
// when an earlier one turns out to be blocked by a dependency nobody had declared).
// survey.candidates carries full detail for the pick and the first few ready tickets.
const byNumber = new Map(survey.candidates.map((i) => [i.number, i]));
const candidates = [
  survey.next.number,
  ...(A.ticket
    ? []
    : survey.candidates
        .filter((i) => i.status === 'ready' && i.number !== survey.next.number)
        .map((i) => i.number)),
].slice(0, A.ticket ? 1 : A.maxCandidates);
if (A.until === 'survey') {
  return finish('stopped', {
    ticket: { number: survey.next.number, title: survey.next.title, status: survey.next.status },
    candidates,
    headline: `Next in #${A.epic}: #${survey.next.number} ${survey.next.title} (${survey.next.status}).`,
  });
}

// ── Per-ticket context ───────────────────────────────────────────────────────────────────────

let T = null; // the ticket being worked: survey item + start output
let W = null; // dedicated worktree
let DIR = null; // helper state dir for this ticket

const situation =
  () => `Repository ${REPO}. Epic #${A.epic} "${survey.epic.title}"; this run works on its ticket #${T.number} "${T.title}".
The ticket's branch ${T.branch} is checked out in the dedicated git worktree ${W}, based on origin/${DEF}. Work only there: use absolute paths with file tools and \`cd ${sh(W)} && …\` or \`git -C ${sh(W)} …\` in shell commands. Never touch other checkouts or branches, and never push.
Files: ${DIR}/issue.md (the ticket and its comments), ${DIR}/epic.md (the epic and a table of every ticket with its status — use it to see what neighbouring tickets own)${T.planFile ? `, ${T.planFile} (the implementation plan)` : ''}.`;

const guidance = `Before editing, read ${W}/AGENTS.md, ${W}/CONTRIBUTING.md, and any AGENTS.md/CLAUDE.md in directories you touch, and follow them. In particular: behavior changes need tests; public exports need TypeDoc comments; guides, both physical skill copies (plugins/agents/… and plugins/claude/…), examples/patterns and the matching Workflow Lab Batch 02 port must stay consistent with code changes; observable changes get a CHANGELOG.md entry under "Unreleased"; cross-cutting design choices get an ADR in docs/decisions/.`;

// ── Handle one candidate; returns a finished record, or null to try the next candidate ────────

// Prepare the worktree and branch; returns a blocked record on failure, else null.
async function startTicket() {
  phase('Plan');
  const started = await one(
    `start #${T.number}`,
    'Plan',
    cmd('start', 'start', { issue: T.number }),
  );
  if (started.error) return blocked('start', started.error);
  if (started.rebase === 'conflict') {
    return blocked(
      'start',
      `branch ${started.branch} from an earlier run no longer rebases cleanly onto origin/${DEF}; resolve it by hand or delete the branch`,
    );
  }
  W = started.worktree;
  DIR = started.dir;
  Object.assign(T, { branch: started.branch, planFile: started.files.plan, started });
  return null;
}

// Returns the planner's PLAN object, or a blocked record.
async function planTicket(extra = '') {
  const started = T.started;
  const earlier = started.resumed
    ? `\nAn earlier run already started this ticket: branch ${started.branch} has ${started.ahead} commit(s) of its own (\`git -C ${sh(W)} log --oneline origin/${DEF}..HEAD\`)${started.files.plan ? ` and its plan is ${started.files.plan}` : ''}${started.dirty.length ? `; the worktree also has uncommitted changes (${started.dirty.length} path(s))` : ''}. Re-validate that work against the ticket and the current code, and return the plan to continue from (steps already done can say so).`
    : '';
  const decided = A.decision
    ? `\nThe maintainer answered the open question on this ticket: "${A.decision}". Plan accordingly; do not return needs-decision for the same question.`
    : '';

  const result = await agent(
    `You decide whether one ticket of an epic is ready to implement now and, if it is, plan the implementation. Your plan drives an implementer (who follows it) and becomes the reference for the landing review. You do not edit code.

${situation()}
${earlier}${decided}${extra}
${standing()}
Read issue.md and epic.md, then the code the ticket concerns (the worktree is at origin/${DEF} plus any earlier commits for this ticket). Line references in the ticket may be stale: many PRs have landed since it was written.

Decide readiness:
- ready: the ticket still describes a real, unaddressed need and can be done as one reviewable PR now.
- obsolete: the code on ${DEF} already satisfies it (obsoleteKind already-done), or it no longer applies (no-longer-applies). Put concrete evidence (paths, lines, tests) in rationale and write issueComment: the closing comment explaining what satisfies or supersedes it.
- needs-decision: it hinges on a product/design choice that is genuinely the maintainer's (not a technical choice you can make and justify). Fill decision (question, 2–4 options with consequences, your recommendation) and write issueComment: the question as it should appear on the issue. Prefer deciding yourself and recording the choice in the plan when a reasonable maintainer would accept either way.
- blocked: it cannot be done well until another open ticket lands. List those issue numbers in blockedBy and write issueComment with one line per dependency, exactly "Depends on #N: <why>".
- split: it is too large for one reviewable PR (roughly: more than ~800 changed lines, or independent parts that each deserve review). Give 2–4 slices in order, each with title, summary, acceptance criteria, and dependsOnPrevious; write issueComment announcing the split. The first slice should be useful on its own.

For ready, write the plan: title (an imperative PR title in this repository's style, e.g. "Persist CLI harness configuration and refuse mismatched resumes"), approach, ordered steps with files, acceptance — one entry per acceptance criterion of the ticket (criterion quoted or paraphrased, and how the change satisfies and tests it) plus any the ticket implies, tests to add, docs/skills/examples/CHANGELOG/ADR updates, risks, outOfScope (related work this PR must not do — especially what other epic tickets own), complexity (mechanical: a competent engineer would implement the plan the same way; subtle: needs careful reasoning about runtime semantics, concurrency, durability, or protocol behavior), and size. Where the ticket leaves a design choice open, make it, and say why in approach. If the ticket asks for a live probe of a CLI, say how to run it at zero or minimal cost.

Fields that do not apply to your readiness verdict are '' or [] ('n/a' for obsoleteKind). Write plain text (no HTML entities).`,
    {
      ...TIER.planner,
      label: `plan #${T.number}${extra ? ' (again)' : ''}`,
      phase: 'Plan',
      schema: PLAN,
    },
  );
  if (!result) return blocked('plan', 'planner returned nothing');
  record.plan = { readiness: result.readiness, rationale: result.rationale };
  log(`#${T.number}: ${result.readiness}`);
  return result;
}

// Closing a ticket on one model's word is how work gets lost: an independent skeptic must agree.
// Returns {agree: true} or the unmet criteria the skeptic found.
async function confirmObsolete(result) {
  const check = await agent(
    `A planner concluded that ticket #${T.number} of epic #${A.epic} needs no work (${result.obsoleteKind}). Try to prove it wrong.

${situation()}

The planner's evidence: ${result.rationale}

Read issue.md and check every acceptance criterion against the code in the worktree (origin/${DEF}). Agree only if each one is demonstrably satisfied (already-done) or genuinely moot (no-longer-applies). Return agree, the evidence you checked, and any criteria that remain unmet.`,
    { ...TIER.skeptic, label: `skeptic #${T.number}`, phase: 'Plan', schema: SKEPTIC },
  );
  return check ?? { agree: false, evidence: 'the skeptic returned nothing', remaining: [] };
}

async function closeObsolete(result) {
  if (!publishing) {
    return finish('stopped', {
      plannedClose: result.issueComment,
      headline: `#${T.number} is obsolete (${result.obsoleteKind}); would close it.`,
    });
  }
  const reason = result.obsoleteKind === 'already-done' ? 'completed' : 'not_planned';
  const out = await clerk(`close #${T.number}`, 'Plan', [
    cmd('close', 'close-issue', {
      issue: T.number,
      flags: `--reason ${reason}`,
      stdin: result.issueComment,
    }),
    ...(reason === 'completed' ? [cmd('tick', 'tick', { issue: T.number })] : []),
  ]);
  if (out.close.error) return blocked('close', out.close.error);
  return finish('closed-obsolete', {
    headline: `Closed #${T.number} "${T.title}" as ${result.obsoleteKind}: ${result.rationale.split('. ')[0]}.`,
  });
}

async function askMaintainer(result) {
  record.decision = { ticket: T.number, ...result.decision };
  if (!publishing) {
    return finish('stopped', {
      headline: `#${T.number} needs a decision: ${result.decision.question}`,
    });
  }
  const posted = await one(
    `ask on #${T.number}`,
    'Plan',
    cmd('ask', 'comment', {
      issue: T.number,
      flags: '--add-label needs-decision',
      stdin: result.issueComment,
    }),
  );
  if (posted.error) return blocked('ask', posted.error);
  return finish('needs-decision', {
    headline: `#${T.number} "${T.title}" needs a decision: ${result.decision.question}`,
    notes: [...record.notes, `question posted: ${posted.url}`],
  });
}

async function recordDependency(result) {
  record.skipped.push({ number: T.number, blockedBy: result.blockedBy, why: result.rationale });
  if (publishing && result.issueComment.trim()) {
    const posted = await one(
      `record deps of #${T.number}`,
      'Plan',
      cmd('deps', 'comment', { issue: T.number, stdin: result.issueComment }),
    );
    if (posted.error)
      record.notes.push(`could not record dependencies on #${T.number}: ${posted.error}`);
  }
  log(
    `#${T.number} is blocked by ${result.blockedBy.map((n) => `#${n}`).join(', ')}; trying the next candidate`,
  );
  return null;
}

async function split(result) {
  record.slices = result.slices.map((s) => ({ title: s.title }));
  if (!publishing) {
    return finish('stopped', {
      plannedSlices: result.slices,
      headline: `#${T.number} would be split into ${result.slices.length} slices.`,
    });
  }
  const written = await agent(
    `Write GitHub issues for the slices of ticket #${T.number} "${T.title}" (epic #${A.epic}, ${REPO}). The split is decided; your job is to write each slice up well.

${situation()}

Model the style on the ticket itself (issue.md): "## Summary" (2–4 sentences), "## Problem" (with path:line references as of origin/${DEF}), "## Proposal", "## Acceptance criteria" (checkboxes), "## Related" (#${T.number} and others), ending with "_Part of #${A.epic}. Split from #${T.number}._". Choose one label: bug, enhancement, or documentation.

The planner's reasoning (design choices every slice must follow; carry the relevant ones into each slice):
${result.rationale}

Slices, in order:
${JSON.stringify(result.slices, null, 1)}

Return one entry per slice in the same order: key "slice-1", "slice-2", …; duplicateOf 0; title; label; body.`,
    {
      ...TIER.scribe,
      label: `write slices #${T.number}`,
      phase: 'Plan',
      schema: WRITEUPS(result.slices.map((_, i) => `slice-${i + 1}`)),
    },
  );
  if (!written || written.issues.length !== result.slices.length) {
    return blocked('split', 'slice write-ups missing or incomplete');
  }
  let after = T.number;
  let previous = null;
  const filed = [];
  for (const [i, s] of written.issues.entries()) {
    const body =
      result.slices[i].dependsOnPrevious && previous
        ? `${s.body.trim()}\n\nDepends on #${previous}.`
        : s.body;
    const out = await one(
      `file slice ${i + 1} of #${T.number}`,
      'Plan',
      cmd(`slice${i + 1}`, 'file-issue', {
        issue: T.number,
        flags: `--title=${sh(s.title)} --label ${s.label} --after ${after}`,
        stdin: body,
      }),
    );
    if (out.error) return blocked('split', `filing slice ${i + 1}: ${out.error}`);
    filed.push(out.number);
    after = out.number;
    previous = out.number;
  }
  // The planner's reasoning holds the design choices the slices share; keep it on the parent.
  const notes = `<details><summary>Planning notes</summary>\n\n${result.rationale.trim()}\n\n</details>`;
  const marker = `${result.issueComment.trim()}\n\nSlices: ${filed.map((n) => `#${n}`).join(', ')}. This ticket closes when they have all landed.\n\n${notes}\n\n<!-- epic:split ${filed.join(',')} -->`;
  const noted = await one(
    `mark #${T.number} split`,
    'Plan',
    cmd('split', 'comment', { issue: T.number, stdin: marker }),
  );
  if (noted.error) return blocked('split', noted.error);
  record.slices = filed.map((n, i) => ({ number: n, title: written.issues[i].title }));
  return finish('split', {
    headline: `Split #${T.number} "${T.title}" into ${filed.map((n) => `#${n}`).join(', ')}; the next run takes #${filed[0]}.`,
  });
}

// ── Implement ────────────────────────────────────────────────────────────────────────────────

let implRound = 0;
async function implement(plan, tier, extra = '') {
  implRound++;
  const label = `impl-${implRound}`;
  return agent(
    `You implement one ticket of an epic, following a reviewed plan. A separate landing workflow will review your PR against the ticket, gate it on CI and automated review, and merge it.

${situation()}
${guidance}
${standing()}
The plan (also in ${T.planFile}; you own the implementation — if a step is wrong in detail, do the right thing and record it in deviations):
${JSON.stringify(plan, null, 1)}
${extra}
Rules:
- First check what is already on the branch (\`git -C ${sh(W)} log --oneline origin/${DEF}..HEAD\`, \`git -C ${sh(W)} status\`): an earlier attempt at this ticket may have committed part or all of the work. Build on correct work rather than redoing it.
- Stay within the ticket's scope and the plan's outOfScope list. Do not refactor unrelated code or reformat untouched files. If you notice a real problem outside scope, don't fix it: add it to followups (title + detail with path:line references).
- Never write to GitHub (no comments, issues, reviews, PRs) and never push: the workflow publishes.
- Commit on the current branch in small logical commits with concise imperative messages${A.commitTrailer ? `, each ending with a blank line and then:\n${A.commitTrailer}\n` : '.'} No new branches, no amending or rewriting existing commits.
- Before checking, format and lint what you touched: \`cd ${sh(W)} && npx prettier --write <files> && npx eslint --fix <files>\`.
- Then run \`node ${sh(TOOL)} check --epic ${A.epic} --issue ${T.number}${ROOT ? ` --root ${sh(ROOT)}` : ''} --label ${label}\` (the full suite, several minutes; prints JSON with passed, failedStep and the log path). If it fails, fix and re-run, at most 4 runs. Never weaken, skip, or delete tests to get green; if a failure is unrelated to your change and pre-existing on origin/${DEF}, say so in notes.
- Commit everything; leave the worktree clean. Finally run \`node ${sh(TOOL)} snapshot --epic ${A.epic} --issue ${T.number}${ROOT ? ` --root ${sh(ROOT)}` : ''}\`.
Return one entry per plan acceptance id: status (done | verify-on-pr | partial | not-done), the short SHA of the commit that delivers it, and evidence (the test or file that shows it). Use verify-on-pr only for a criterion that cannot be checked until the PR exists, such as a CI job's duration or GitHub-side state like code-scanning alerts: do everything that can be done locally, and put in evidence exactly what to check on the PR and what result counts as met. Also checkPassed (from your last check), head (from snapshot), deviations from the plan, followups, and notes. Plain text, no HTML entities.`,
    {
      ...tier,
      label,
      phase: 'Implement',
      schema: IMPLEMENTED(plan.acceptance.map((c) => c.id)),
    },
  );
}

// verify-on-pr: done locally, but only checkable once the PR exists (CI timings, alerts). Those
// criteria go to the landing review as explicit checks instead of blocking here.
const SETTLED = new Set(['done', 'verify-on-pr']);

async function implementTicket(plan) {
  phase('Implement');
  const auto = plan.complexity === 'subtle' || plan.size === 'large' ? 'surgeon' : 'mechanic';
  let tierName = A.implementer === 'auto' ? auto : A.implementer;
  let result = await implement(plan, TIER[tierName]);
  if (!result) {
    log('implementer ended without a result; retrying once');
    result = await implement(
      plan,
      TIER[tierName],
      `\nA previous attempt ended without reporting. It may have committed some of the work: check \`git -C ${sh(W)} log --oneline origin/${DEF}..HEAD\` and \`git -C ${sh(W)} status\`, keep what is correct, finish the rest, and report every acceptance id.`,
    );
  }
  const unfinished = (r) =>
    !r ||
    !r.checkPassed ||
    plan.acceptance.some((c) => !SETTLED.has(r.criteria.find((x) => x.id === c.id)?.status));
  if (unfinished(result) && tierName === 'mechanic') {
    log('mechanic left work unfinished or checks failing; escalating to the surgeon tier');
    tierName = 'surgeon';
    result = await implement(
      plan,
      TIER.surgeon,
      `\nA previous attempt (notes: ${JSON.stringify(result?.notes ?? [])}; criteria: ${JSON.stringify(result?.criteria ?? [])}) left work unfinished or the check suite failing; the newest impl-*.log in ${DIR} has the last check output. Finish the job.`,
    );
  }
  record.implementer = { tier: tierName, rounds: implRound };
  if (!result) return { error: 'implementer returned nothing' };
  const missingIds = plan.acceptance.filter((c) => !result.criteria.some((x) => x.id === c.id));
  if (missingIds.length) {
    return { error: `implementer did not report: ${missingIds.map((c) => c.id).join(', ')}` };
  }
  const open = result.criteria.filter((c) => !SETTLED.has(c.status));
  if (open.length) {
    return {
      error: `unfinished criteria: ${open.map((c) => `${c.id} (${c.status}: ${c.evidence})`).join('; ')}`,
    };
  }
  // Don't take the implementer's word: commits on the branch, clean tree, green check at head.
  const commits = [...new Set(result.criteria.map((c) => c.commit.trim()).filter(Boolean))].join(
    ',',
  );
  const v = await one(
    `verify #${T.number}`,
    'Implement',
    cmd('verify', 'verify', { issue: T.number, flags: commits ? `--commits ${commits}` : '' }),
  );
  if (v.error) return { error: `could not verify: ${v.error}` };
  if (!v.ahead) return { error: 'the branch has no commits of its own' };
  if (v.missingCommits.length)
    return { error: `reported commits not on the branch: ${v.missingCommits.join(', ')}` };
  if (v.dirty.length) return { error: `worktree not clean: ${v.dirty.slice(0, 5).join(', ')}` };
  if (!v.checkPassedAtHead)
    return { error: `no passing check recorded for head ${v.head.slice(0, 7)}` };
  record.implementer = {
    ...record.implementer,
    head: v.head,
    commits: v.ahead,
    deviations: result.deviations,
    notes: result.notes,
  };
  record.verifyOnPr = result.criteria
    .filter((c) => c.status === 'verify-on-pr')
    .map((c) => ({ id: c.id, check: c.evidence }));
  return { result, head: v.head };
}

// ── Publish ──────────────────────────────────────────────────────────────────────────────────

async function ensureFollowupEpic() {
  if (record.followupEpic) return record.followupEpic;
  const body = `This epic collects follow-ups found while burning down #${A.epic} ("${survey.epic.title}") with the execute-epic-ticket workflow. Each item is a self-contained issue.\n\n## Items\n\n_Created by the execute-epic-ticket workflow._`;
  const step = cmd('epic', 'ensure-epic', {
    flags: `--title=${sh(A.followupEpicTitle)}`,
    stdin: body,
  });
  const out = await one('ensure follow-up epic', 'Publish', step);
  if (out.error) throw new Error(`follow-up epic: ${out.error}`);
  record.followupEpic = out.number;
  if (out.created) log(`Created follow-up epic #${out.number}`);
  return out.number;
}

async function fileFollowups(items) {
  const epic = await ensureFollowupEpic();
  const written = await agent(
    `Write up follow-up issues noticed while implementing ticket #${T.number} "${T.title}" of epic #${A.epic} in ${REPO}. They are out of that ticket's scope and will be filed under follow-up epic #${epic}.

${situation()}

For each item, first look for an existing open issue that already covers it (\`gh issue list -R ${REPO} --state open --search "<keywords>"\`); if one does, set duplicateOf to its number and leave body ''. Otherwise write the issue in the style of the ticket itself: "## Summary" (2–4 sentences), "## Problem" (path:line references as of origin/${DEF}), "## Proposal", "## Acceptance criteria" (checkboxes), "## Related" (#${T.number} and others), ending with "_Part of #${epic}. Found while implementing #${T.number}._". Choose one label: bug, enhancement, or documentation. Do not file anything yourself.

Items:
${items.map((f, i) => `### [f${i + 1}] ${f.title}\n${f.detail}`).join('\n\n')}

Return one entry per item with key f1, f2, …; duplicateOf is 0 when there is no duplicate.`,
    {
      ...TIER.scribe,
      label: `write follow-ups #${T.number}`,
      phase: 'Publish',
      schema: WRITEUPS(items.map((_, i) => `f${i + 1}`)),
    },
  );
  const filed = [];
  for (const w of written?.issues ?? []) {
    if (w.duplicateOf) {
      filed.push({ key: w.key, number: w.duplicateOf, action: 'duplicate' });
      continue;
    }
    // file-issue attaches the new issue to the epic named by --epic: the follow-up epic here.
    const out = await one(
      `file ${w.key}`,
      'Publish',
      cmd(`file-${w.key}`, 'file-issue', {
        epic,
        flags: `--title=${sh(w.title)} --label ${w.label}`,
        stdin: w.body,
      }),
    );
    filed.push(
      out.error
        ? { key: w.key, error: out.error }
        : {
            key: w.key,
            number: out.number,
            title: w.title,
            action: out.created ? 'created' : 'existing',
          },
    );
  }
  record.followups.push(...filed);
  return filed;
}

async function writePr(plan, impl) {
  const snap = await one(
    `snapshot #${T.number}`,
    'Publish',
    cmd('snapshot', 'snapshot', { issue: T.number }),
  );
  if (snap.error) throw new Error(`snapshot: ${snap.error}`);
  const text = await agent(
    `Write the pull request description for ticket #${T.number} "${T.title}" (epic #${A.epic}, ${REPO}).

${situation()}

Facts (the source of truth; don't re-investigate the code beyond what you need to describe it accurately):
- Plan: ${JSON.stringify({ title: plan.title, approach: plan.approach, risks: plan.risks, outOfScope: plan.outOfScope })}
- Implementer report: ${JSON.stringify({ criteria: impl.criteria, deviations: impl.deviations, notes: impl.notes })}
- Diff: ${snap.stat}; commits in ${snap.files.commits}; full diff in ${snap.files.diff}.

Style (match this repository's merged PRs, e.g. \`gh pr view 97 -R ${REPO}\`): start with "Closes #${T.number}." on its own line, then "Part of #${A.epic}."; a short paragraph on the problem and what changes; then what changed for users/authors (behavior, API, CLI, docs), design choices and why, anything deliberately left out (with the ticket that owns it), and a "Validation" paragraph (what was run and passed). Reference issues as #N and commits by short SHA. No boilerplate, no praise, no headings unless it runs long. End with a blank line and then:
${A.prFooter}

Return title (default: ${JSON.stringify(plan.title)}; keep it under 72 characters) and body (markdown).`,
    { ...TIER.scribe, label: `PR text #${T.number}`, phase: 'Publish', schema: PR_TEXT },
  );
  if (!text) throw new Error('PR description writer returned nothing');
  return text;
}

const AWAIT_LOOP = (
  listing,
) => `Run this command with the Bash tool (timeout 600000 ms). It waits up to 9 minutes and prints one line of JSON.

${listing}

If that JSON contains "done":false, run the exact same command again; repeat until "done" is true or you have run it 4 times. Do nothing else.

${RELAY_RULES} The only id is "await": relay the output of the last run.`;

// Codex reviews a PR automatically when it opens. Waiting for that review (and CI) before handing
// over lets merge-down-pr's first review triage Codex's threads instead of racing them.
async function awaitFirstReview(pr, sha, since) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const step = mdCmd(
      'await',
      'await',
      pr,
      `--sha ${sha} --since ${since} --codex required --max-seconds 540`,
    );
    const gate = (await clerk(`await review #${pr}.${attempt}`, 'Publish', [step], AWAIT_LOOP))
      .await;
    if (gate.done || gate.error) return gate;
  }
  return { done: false, timedOut: true };
}

// ── Main loop over candidates ────────────────────────────────────────────────────────────────

let ticketResult = null;
for (const number of candidates) {
  const item = byNumber.get(number) ?? { number, title: `#${number}`, status: 'ready' };
  T = { number, title: item.title, status: item.status, pr: item.pr ?? null };
  record.ticket = { number, title: item.title, status: item.status };
  log(`Ticket #${number} ${item.title} (${item.status})`);

  if (item.status === 'closed')
    return finish('stopped', { headline: `#${number} is already closed.` });
  if (item.status === 'waiting') {
    return finish('stalled', {
      headline: `#${number} waits on ${item.openDeps.map((d) => `#${d}`).join(', ')}.`,
    });
  }
  if (item.status === 'split') {
    return finish('split', {
      headline: `#${number} is split; its open slices are ${item.openSlices.map((d) => `#${d}`).join(', ')}.`,
    });
  }
  if (item.status === 'close-split') {
    if (!publishing)
      return finish('stopped', {
        headline: `#${number}'s slices have all closed; would close it.`,
      });
    const out = await clerk(`close split #${number}`, 'Plan', [
      cmd('close', 'close-issue', {
        issue: number,
        flags: '--reason completed',
        stdin: `All slices of this ticket have landed (${(item.split ?? []).map((n) => `#${n}`).join(', ')}); closing.`,
      }),
      cmd('tick', 'tick', { issue: number }),
    ]);
    if (out.close.error) return blocked('close', out.close.error);
    return finish('closed-split', {
      headline: `Closed #${number}: all of its slices have landed.`,
    });
  }
  if (item.status === 'held') {
    const decisionPending = (item.labels ?? []).includes('needs-decision');
    if (!(decisionPending && A.decision)) {
      return finish('held', {
        headline: `#${number} is held (${(item.labels ?? []).join(', ')})${decisionPending ? '; rerun with args.decision once the question on it is answered' : ''}.`,
      });
    }
  }
  if (A.decision && publishing) {
    // Record the answer durably on the ticket (later planners and the landing review read it).
    const posted = await one(
      `record decision on #${number}`,
      'Plan',
      cmd('decision', 'comment', {
        issue: number,
        flags: '--remove-label needs-decision',
        stdin: `**Decision** (from the maintainer): ${A.decision}`,
      }),
    );
    if (posted.error) return blocked('decision', posted.error);
  }

  if (item.status === 'in-flight') {
    // An open PR already carries this ticket: go straight to landing.
    if (item.pr.isDraft) {
      return blocked(
        'survey',
        `PR #${item.pr.number} for #${number} is a draft; finish or undraft it first`,
      );
    }
    T.inFlight = true;
    ticketResult = {
      pr: item.pr.number,
      url: item.pr.url,
      head: item.pr.headSha,
      openedAt: item.pr.createdAt,
      inFlight: true,
    };
    break;
  }

  const startFailed = await startTicket();
  if (startFailed) return startFailed;
  let result = await planTicket();
  if (result.status) return result; // a finished (blocked) record
  if (result.readiness === 'obsolete') {
    const check = await confirmObsolete(result);
    if (check.agree) return closeObsolete(result);
    // The skeptic found unmet criteria: plan the remaining work instead of closing the ticket.
    log(`Skeptic disagrees that #${number} is obsolete; re-planning the remaining work`);
    record.notes.push(`not obsolete after all: ${check.remaining.join('; ') || check.evidence}`);
    result = await planTicket(
      `\nAn earlier pass judged this ticket ${result.obsoleteKind}, but an independent check found work remaining: ${JSON.stringify(check)}. Do not return obsolete; plan what remains (or return another verdict if one genuinely applies).`,
    );
    if (result.status) return result;
    if (result.readiness === 'obsolete') {
      return blocked('plan', `planner and skeptic disagree on whether #${number} is obsolete`);
    }
  }
  if (result.readiness === 'needs-decision') return askMaintainer(result);
  if (result.readiness === 'split') return split(result);
  if (result.readiness === 'blocked') {
    await recordDependency(result);
    continue;
  }

  // Ready: persist the plan beside the branch, so a later run (or a human) can pick it up.
  const saved = await one(
    `save plan #${number}`,
    'Plan',
    cmd('save', 'save', {
      issue: number,
      flags: '--name plan.json',
      stdin: JSON.stringify(result.plan, null, 2),
    }),
  );
  if (saved.error) return blocked('plan', `could not save the plan: ${saved.error}`);
  T.planFile = saved.path;
  record.plan = {
    ...record.plan,
    title: result.plan.title,
    complexity: result.plan.complexity,
    size: result.plan.size,
    criteria: result.plan.acceptance.length,
  };
  if (A.until === 'plan')
    return finish('stopped', {
      plannedWork: result.plan,
      headline: `Planned #${number}: ${result.plan.title}.`,
    });

  const impl = await implementTicket(result.plan);
  if (impl.error) return blocked('implement', impl.error);
  log(`#${number} implemented at ${impl.head.slice(0, 7)} (${record.implementer.tier})`);
  if (A.until === 'implement') {
    return finish('stopped', {
      headline: `Implemented #${number} on ${T.branch} (${impl.head.slice(0, 7)}); not published.`,
    });
  }

  phase('Publish');
  const [prText, filed] = await parallel([
    () => writePr(result.plan, impl.result),
    () =>
      impl.result.followups.length ? fileFollowups(impl.result.followups) : Promise.resolve([]),
  ]);
  if (!prText) return blocked('publish', 'could not write the PR description');
  if (impl.result.followups.length && !filed)
    record.notes.push('follow-up filing failed; see the implementer notes');
  const opened = await one(
    `open PR #${number}`,
    'Publish',
    cmd('open', 'open-pr', {
      issue: number,
      flags: `--title=${sh(prText.title)}`,
      stdin: prText.body,
    }),
  );
  if (opened.error) return blocked('publish', opened.error);
  ticketResult = opened;
  break;
}
if (!ticketResult) {
  return finish('stalled', {
    headline: `No candidate in #${A.epic} was ready this run: ${record.skipped.map((s) => `#${s.number} (blocked by ${s.blockedBy.map((n) => `#${n}`).join(', ')})`).join('; ')}.`,
  });
}

record.pr = { number: ticketResult.pr, url: ticketResult.url };
log(
  `PR #${ticketResult.pr} ${ticketResult.inFlight ? '(already open)' : 'opened'}: ${ticketResult.url}`,
);

if (!T.inFlight) {
  const first = await awaitFirstReview(ticketResult.pr, ticketResult.head, ticketResult.openedAt);
  if (first.error) record.notes.push(`waiting for the first Codex review failed: ${first.error}`);
  else if (!first.done)
    record.notes.push(
      'the first Codex review did not finish in time; merge-down-pr will request one',
    );
  else log(`First review: CI ${first.ci?.state}; Codex ${first.codex?.state}`);
}
if (A.until === 'pr') {
  return finish('pr-open', {
    headline: `Opened PR #${ticketResult.pr} for #${T.number} "${T.title}".`,
  });
}

// ── Land (inline child workflow) ─────────────────────────────────────────────────────────────

phase('Land');
let followupEpic;
try {
  followupEpic = await ensureFollowupEpic();
} catch (error) {
  return blocked('land', String(error?.message ?? error));
}
let landed;
try {
  landed = await workflow(A.mergeDownScript ? { scriptPath: A.mergeDownScript } : 'merge-down-pr', {
    ...A.mergeDown,
    pr: ticketResult.pr,
    parentEpic: A.epic,
    followupEpic,
    followupEpicTitle: A.followupEpicTitle,
    standingNotes: [
      ...A.standingNotes,
      `This PR implements #${T.number} of epic #${A.epic} and was written by the execute-epic-ticket workflow${T.planFile ? ` from the plan in ${T.planFile}` : ''}. Judge it against the ticket's acceptance criteria; work the epic's other tickets own is out of scope (see the epic's checklist).`,
      ...(record.verifyOnPr?.length
        ? [
            `These acceptance criteria could only be checked once the PR existed; CI has run on it, so check each one now (e.g. \`gh run view\` timings, code-scanning alerts) and treat an unmet one as a fix: ${record.verifyOnPr.map((c) => `[${c.id}] ${c.check}`).join(' ')}`,
          ]
        : []),
    ],
  });
} catch (error) {
  return blocked('land', `merge-down-pr could not start: ${error?.message ?? error}`);
}
record.landing = landed
  ? {
      status: landed.status,
      mergeCommit: landed.mergeCommit,
      threads: landed.threads?.length ?? 0,
      fixes: (landed.fixes ?? []).length,
      followups: landed.followups ?? [],
      summaryCommentUrl: landed.summaryCommentUrl,
      headline: landed.headline,
      blocked: landed.blocked,
    }
  : null;
if (landed?.followupEpic) record.followupEpic = landed.followupEpic;
if (!landed) return blocked('land', 'merge-down-pr returned nothing');
if (landed.status !== 'merged') {
  return blocked(
    'land',
    `merge-down-pr ended ${landed.status}${landed.blocked ? ` at ${landed.blocked.stage}: ${landed.blocked.reason}` : ''}; PR #${ticketResult.pr} stays open and the next run resumes it`,
  );
}
record.pr.mergeCommit = landed.mergeCommit;

// ── Report ───────────────────────────────────────────────────────────────────────────────────

phase('Report');
const ledgerLine = JSON.stringify({
  ticket: T.number,
  title: T.title,
  pr: ticketResult.pr,
  mergeCommit: landed.mergeCommit,
  implementer: record.implementer?.tier ?? null,
  landing: { threads: record.landing.threads, fixes: record.landing.fixes },
  followups: [...record.followups, ...(landed.followups ?? [])]
    .map((f) => f.number)
    .filter(Boolean),
});
const after = await clerk(`report #${T.number}`, 'Report', [
  cmd('tick', 'tick', { issue: T.number }),
  cmd('ledger', 'ledger', { stdin: ledgerLine }),
  cmd('resurvey', 'survey', { flags: '--candidates 1' }),
]);
if (after.tick.error)
  record.notes.push(`could not tick #${T.number} in the epic: ${after.tick.error}`);
if (!after.resurvey.error) {
  record.remaining = after.resurvey.counts;
  record.next = after.resurvey.next;
}
record.agents = { clerkRuns };
return finish('landed', {
  headline:
    `#${T.number} "${T.title}" landed as PR #${ticketResult.pr} (${String(landed.mergeCommit).slice(0, 7)}). ${plain(landed.headline ?? '')}`.trim(),
});
