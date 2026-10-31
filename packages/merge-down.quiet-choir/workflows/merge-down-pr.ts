// merge-down-pr: land exactly one PR, the way a careful maintainer would. Control flow only: the
// prose is in prompts/, the agents in roster.ts, the contracts in contracts.ts and the mechanics in
// lib/. Stages: Prepare, Rebase (only on conflicts), Review, Fix, Gate (publish, wait, triage, loop),
// Land, Report. Dependabot PRs take a dependency review (merge, fix, close or defer) and no Codex.
import { defineWorkflow, z, type JsonValue } from 'quiet-choir';
import {
  codeqlReviewer,
  codexReviewer,
  github,
  type GithubReviewThread,
  type WaitChecksResult,
} from 'quiet-choir/github';
import * as std from 'quiet-choir/std';
import {
  CodexTriage,
  DependencyReview,
  Fix,
  FollowupDrafts,
  MergeDownInput,
  MergeDownResult,
  Report,
  Resolve,
  Review,
  Triage,
  type FixResult,
} from '../contracts.js';
import { FOREIGN_WORKTREE, runCheck } from '../lib/checks.js';
import { localCodexReview, type LocalReview } from '../lib/codex.js';
import { cleanupBranch, ownedAgent, publish, snapshot, sync, verifyFixes } from '../lib/git.js';
import { landMerge } from '../lib/land.js';
import {
  canonicalizeKeys,
  checkItem,
  ciItem,
  closedNote,
  deferrable,
  deferredDetail,
  ensureClosesBody,
  escalationReasons,
  fallbackHeadline,
  followupFooter,
  isDependency,
  itemsFrom,
  keepOpenBody,
  latestMajor,
  majorBump,
  plain,
  reopenNote,
  replyFor,
  underLimit,
  unfixed,
  unregisteredRequired,
  toolchainNote,
  type PlannedReply,
  type ThreadDecision,
  type WorkItem,
} from '../lib/policy.js';
import {
  CI_IGNORED_REVIEWER,
  preparePr,
  readThreads,
  resolvePaths,
  resolveRepo,
  summary,
} from '../lib/prepare.js';
import { FixTeam, ResolveTeam } from '../lib/teams.js';
import { prompts, type Situation } from '../prompts.js';
import { roster, toolchainAgents, type Staff } from '../roster.js';

type Ledger = MergeDownResult;
type Status = Ledger['status'];
interface Work {
  fix: WorkItem[];
  followup: WorkItem[];
}
type Filed = { key: string; number: number }[];
interface ReviewSummary {
  escalated: boolean;
  alignment: Review['alignment'] | null;
  findings: {
    id: string;
    title: string;
    severity: 'blocker' | 'major' | 'minor';
    disposition: string;
  }[];
  issueDisposition?: Review['issueDisposition'];
  summaryNotes?: string[];
}
/** Work items as the ledger's plain data. */
const planned = (work: Work) => ({
  fix: work.fix.map((i) => ({ ...i, files: [...i.files] })),
  followup: work.followup.map((i) => ({ ...i, files: [...i.files] })),
});
type RoundResult = { replies: PlannedReply[]; changed: boolean } | { error: string };

const HOUR = 3_600_000;
const write = { retry: { maxAttempts: 3, on: ['process', 'timeout'] as const } };

export default defineWorkflow({
  name: 'merge-down-pr',
  version: '1',
  description:
    'Land one PR: rebase onto main, review against its issue with a local Codex review, triage threads, fix, gate on CI + Codex, merge (squash by default), report',
  whenToUse:
    'Merging down a stack of agent-authored PRs (or Dependabot PRs) one PR per run, in stack order.',
  input: MergeDownInput,
  output: MergeDownResult,
  roster,
  prompts: [prompts],
  async run(ctx, A) {
    const LOCAL = A.codexMode === 'local';
    const publishing = A.until === 'merge';
    // ci: 'ignore' (#738): GitHub CI is never read; the local suite and the reviewers gate the merge.
    const IGNORE_CI = A.ci === 'ignore';
    // The code-scanning reviewer waits for an analysis check, which CI publishes: without CI it
    // would wait out its deadline. The reviewer wait still reads the open threads and alerts.
    const scanner = () => (IGNORE_CI ? CI_IGNORED_REVIEWER : codeqlReviewer());
    const ciNotConsulted = (sha: string): WaitChecksResult => ({
      status: 'success',
      headRefOid: sha,
      failed: [],
      pending: [],
    });
    // The review summary the ledger keeps; a stop short of merge replaces it with the whole review.
    const reviewSummary: ReviewSummary = { escalated: false, alignment: null, findings: [] };
    const record: Ledger = {
      pr: A.pr,
      url: null,
      title: null,
      kind: null,
      status: 'stopped',
      issue: null,
      mergeCommit: null,
      rebase: null,
      review: reviewSummary,
      threads: [],
      codexReviewsRequested: 0,
      codexMode: A.codexMode,
      localReviews: [],
      codexFindings: [],
      rounds: 0,
      ciRepairs: 0,
      followups: [],
      followupEpic: A.followupEpic ?? null,
      summaryCommentUrl: null,
      headline: null,
      notes: [],
      blocked: null,
    };
    const finish = (status: Status, extra: Partial<Ledger> = {}): Ledger => {
      Object.assign(record, { status }, extra);
      record.headline = plain(record.headline);
      return record;
    };
    const blocked = (stage: string, reason: string): Ledger => {
      ctx.log(`Blocked at ${stage}: ${reason}`);
      return finish('blocked', { blocked: { stage, reason } });
    };

    // ── Prepare ─────────────────────────────────────────────────────────────────────────────
    ctx.phase('Prepare');
    const repo = await resolveRepo(ctx, A.repo);
    const gh = github(ctx, { repo });
    const paths = await resolvePaths(ctx, A.root, A.pr);
    const W = paths.workdir;
    const DIR = paths.dir;
    const prepared = await preparePr(ctx, gh, { number: A.pr, paths });
    const { pr: PR, issue: ISSUE, info } = prepared;
    const DEF = info.defaultBranch;
    if (DEF === null) return blocked('prepare', `${repo} has no default branch`);
    const kind = isDependency(PR.headRefName) ? 'dependency' : 'change';
    Object.assign(record, {
      url: PR.url,
      title: PR.title,
      kind,
      issue: ISSUE && {
        number: ISSUE.number,
        url: ISSUE.url,
        title: ISSUE.title,
        state: ISSUE.state,
      },
    });
    if (PR.state !== 'OPEN') return finish('skipped', { notes: [`PR is ${PR.state}`] });
    // The sync checks out origin/<head branch> and the gate pushes there, so a head in a fork (or a
    // deleted one) would publish to a same-named branch of this repository instead.
    const headRepo = await ctx.exec.json(
      ctx.id('head-repo', A.pr),
      [
        'gh',
        'api',
        `repos/${info.nameWithOwner}/pulls/${String(A.pr)}`,
        '--jq',
        '{repo: .head.repo.full_name}',
      ],
      { schema: z.object({ repo: z.string().nullable() }), ...write },
    );
    if (headRepo.repo?.toLowerCase() !== info.nameWithOwner.toLowerCase())
      return blocked(
        'prepare',
        `PR head is in ${headRepo.repo ?? 'a deleted fork'}, not ${info.nameWithOwner}; merge-down only lands same-repository PRs`,
      );
    const synced = await sync(ctx, 'sync', {
      pr: A.pr,
      repo: info.nameWithOwner,
      base: DEF,
      paths,
      headRefName: PR.headRefName,
      baseRefName: PR.baseRefName,
      parent: prepared.parent,
      open: prepared.open.map((o) => ({
        number: o.number,
        baseRefName: o.baseRefName,
        headRefName: o.headRefName,
      })),
    });
    const SYNC = synced;
    let reviewHead = SYNC.newHead;
    record.rebase = {
      status: SYNC.status,
      forkSource: SYNC.forkSource,
      conflicts: SYNC.conflictedFiles,
    };
    const prSummary = summary(prepared, paths);
    ctx.log(
      `#${String(A.pr)} ${PR.title}: ${kind}${ISSUE ? `, issue #${String(ISSUE.number)}` : ''}; rebase ${SYNC.status}; ${String(prSummary.codex.unresolvedThreads)} open Codex thread(s); CI ${PR.checks.state}`,
    );
    if (PR.isDraft) return blocked('prepare', 'PR is a draft');
    if (ISSUE?.alsoCloses.length) {
      // GitHub would close all of them on merge, but the review judges the PR against one issue.
      const all = [ISSUE.number, ...ISSUE.alsoCloses].map((n) => `#${String(n)}`).join(', ');
      return blocked('prepare', `PR closes several issues (${all}); split it or land it by hand`);
    }
    if (SYNC.status === 'blocked') return blocked('rebase', SYNC.reason ?? 'sync refused');
    if (SYNC.status === 'error')
      return blocked('rebase', `rebase failed without conflicts; see ${String(SYNC.log)}`);
    // The branch the sync checked out must hold the head Prepare read, or the push would lease on
    // and publish over a head nobody reviewed.
    if (SYNC.origHead !== null && SYNC.origHead !== PR.headRefOid)
      return blocked(
        'rebase',
        `origin/${PR.headRefName} is ${SYNC.origHead}, not the PR head ${PR.headRefOid}; the head moved since Prepare or lives elsewhere; re-run`,
      );
    if (SYNC.forkSource && SYNC.forkSource !== 'recorded' && PR.baseRefName !== DEF)
      record.notes.push(
        `fork point came from ${SYNC.forkSource}, not a recorded ref; verify the rebase kept only this PR's commits`,
      );
    if (A.until === 'prepare') {
      const pathsJson = { root: paths.root, workdir: W, stateDir: paths.stateDir };
      const preparedJson = {
        paths: pathsJson,
        repo,
        defaultBranch: DEF,
        pr: prSummary,
        sync: SYNC,
      };
      return finish('stopped', { prepared: preparedJson as unknown as JsonValue });
    }

    const situation: Situation = {
      repo: info.nameWithOwner,
      pr: A.pr,
      title: PR.title,
      url: PR.url,
      issue: ISSUE && { number: ISSUE.number, title: ISSUE.title },
      base: DEF,
      worktree: W,
      branch: SYNC.localBranch,
      dir: DIR,
      upstreamDelta: SYNC.forkPoint !== null,
      toolchain: toolchainNote(A.toolchain),
    };
    // The roster's roles; with a toolchain, bound with its shell rules instead of npm's (#735).
    const R: Staff = A.toolchain === undefined ? ctx.roster : toolchainAgents(ctx, A.toolchain);
    const place = { cwd: W, addDirs: [DIR], onError: 'return' } as const;
    // What an agent that edits the worktree checks first (see ownedAgent).
    const owner = { workdir: W, pr: A.pr, dir: DIR };
    const standingNotes = A.standingNotes;
    const roundCaps = { maxCodexRounds: A.maxCodexRounds, hardCap: A.codexRoundsHardCap };

    // ── Rebase: semantic conflict resolution ────────────────────────────────────────────────
    if (SYNC.status === 'conflict') {
      ctx.phase('Rebase');
      const team: ResolveTeam = ResolveTeam.from({
        resolver: kind === 'dependency' ? R.Mechanic : R.Surgeon,
      });
      const resolved = await ownedAgent(ctx, 'resolve', owner, () =>
        team.resolver.value('resolve', {
          ...place,
          prompt: prompts.ResolveConflicts({
            situation,
            standingNotes,
            forkPoint: SYNC.forkPoint ?? '',
            origHead: SYNC.origHead ?? '',
            conflicted: SYNC.conflictedFiles,
          }),
          schema: Resolve,
        }),
      );
      if ('refused' in resolved) return blocked('rebase', resolved.refused);
      const resolution = resolved.value;
      if (!resolution.ok || !resolution.value.completed) {
        const concerns = resolution.ok ? resolution.value.concerns.join('; ') : '';
        return blocked('rebase', concerns || 'conflict resolution did not complete');
      }
      // Don't take the resolver's word for it: the snapshot fails while a rebase is in progress,
      // and a rebase that lost the PR's commits leaves nothing of its own to publish.
      const verified = await snapshot(ctx, 'verify-rebase', { paths, base: DEF });
      if (!verified.ok) return blocked('rebase', `rebase not finished: ${verified.error.message}`);
      if (!verified.value.ownCommits)
        return blocked('rebase', "the rebase left none of the PR's commits");
      if (SYNC.originalCommits && verified.value.ownCommits < SYNC.originalCommits)
        record.notes.push(
          `rebase kept ${String(verified.value.ownCommits)} of ${String(SYNC.originalCommits)} commits (some became empty); check the history`,
        );
      reviewHead = verified.value.head;
      Object.assign(record.rebase, {
        resolutions: resolution.value.resolutions,
        concerns: resolution.value.concerns,
      });
    }
    const rebase = {
      status: SYNC.status,
      upstreamDelta: SYNC.upstreamDelta ?? '',
      resolutions: JSON.stringify(record.rebase.resolutions ?? []),
      concerns: JSON.stringify(record.rebase.concerns ?? []),
    };

    // ── Review (∥ local checks ∥ first local Codex review) ──────────────────────────────────
    ctx.phase('Review');
    const reviewAt = (label: string, sha: string): Promise<LocalReview> =>
      localCodexReview(ctx, {
        label,
        paths,
        base: DEF,
        sha,
        model: A.codexModel,
        effort: A.codexEffort ?? null,
      });
    const check = (label: string) =>
      runCheck(ctx, ctx.id('check', label), {
        workdir: W,
        pr: A.pr,
        dir: DIR,
        label,
        command: A.checkCommand,
      });
    const firstLocalHead = kind === 'change' && LOCAL && A.codex !== 'never' ? reviewHead : null;
    const [check0, firstReview, firstLocal] = await Promise.all([
      check('check-0'),
      kind === 'dependency'
        ? (majorBump(PR.title) ? R.Reviewer : R.Mechanic)
            .value('dependency-review', {
              ...place,
              prompt: prompts.ReviewDependency({
                situation,
                rebase,
                failedChecks:
                  PR.checks.state === 'failure' && !IGNORE_CI ? [...PR.checks.failed] : [],
              }),
              schema: DependencyReview,
            })
            .then((r) => (r.ok ? ({ dependency: r.value } as const) : null))
        : R.Reviewer.value('review', {
            ...place,
            prompt: prompts.ReviewChange({
              situation,
              rebase,
              standingNotes,
              laterInStack: prepared.later.length,
              parentEpic: A.parentEpic ?? null,
              unresolvedThreads:
                prSummary.codex.unresolvedThreads + prSummary.otherUnresolvedThreads,
            }),
            schema: Review,
          }).then((r) => (r.ok ? ({ change: r.value } as const) : null)),
      firstLocalHead === null ? Promise.resolve(null) : reviewAt('r0', firstLocalHead),
    ]);
    if (!firstReview) return blocked('review', 'reviewer returned nothing');
    if (check0.failedStep === FOREIGN_WORKTREE) return blocked('review', String(check0.error));
    const firstLocalOk = firstLocal !== null && firstLocal.error === null;
    // The last head that passed the suite: the only head publish pushes.
    let checkedHead = check0.passed ? check0.head : null;
    ctx.log(
      `Local checks ${check0.passed ? 'pass' : `fail at ${check0.failedStep ?? String(check0.error)}`}`,
    );

    // Earlier decisions, for triage consistency, and the thread records the ledger keeps.
    const threadInfo = new Map<string, GithubReviewThread>(prepared.threads.map((t) => [t.id, t]));
    const remember = (threads: readonly ThreadDecision[], round: number): void => {
      for (const t of threads)
        record.threads.push({
          id: t.id,
          title: t.title,
          verdict: t.verdict,
          action: t.action,
          severity: t.severity,
          round,
          reply: t.reply,
        });
    };
    const findingsSeen = new Map<
      string,
      { title: string; disposition: string; verdict?: string }
    >();

    // Turns a local Codex review into work items, or an error that blocks the run.
    const triageLocal = async (
      result: LocalReview,
      round: number,
    ): Promise<
      | { fix: WorkItem[]; followup: WorkItem[]; findings: { severity: string; verdict: string }[] }
      | { error: string }
    > => {
      const none = { fix: [], followup: [], findings: [] };
      record.localReviews.push({
        round,
        sha: result.sha.slice(0, 12),
        findings: result.findings,
        priorities: result.priorities,
        elapsedSeconds: result.elapsedSeconds,
        file: result.file,
        deps: result.deps,
        error: result.error,
      });
      if (result.deps === 'missing')
        record.notes.push(
          `local Codex review in round ${String(round)} ran without dependencies (npm ci failed)`,
        );
      if (result.error !== null || result.file === null) {
        record.notes.push(
          `local Codex review in round ${String(round)} failed (${result.error ?? 'no output'}); proceeding without it`,
        );
        return none;
      }
      ctx.log(
        `Local Codex review r${String(round)}: ${String(result.findings)} finding(s) in ${String(result.elapsedSeconds)}s`,
      );
      if (!result.findings) return none;
      // Note, follow-up and deferred decisions settle a repeat; a fix that Codex reports again may
      // not have worked, so it is checked against the code.
      const deferredKeys = new Map((record.deferredFindings ?? []).map((d) => [d.key, d]));
      const outcome = (id: string, disposition: string): string => {
        const d = deferredKeys.get(`finding:${id}`);
        if (d) return `, deferred to follow-up${d.issue === null ? '' : ` #${String(d.issue)}`}`;
        return disposition === 'fix' ? ', fix attempted' : '';
      };
      const known = [...findingsSeen].map(
        ([id, f]) =>
          `- ${id}: ${f.title} (${f.verdict ? `${f.verdict}, ` : ''}${f.disposition}${outcome(id, f.disposition)})`,
      );
      const ask = (shortfall: { covered: number; ids: string[] } | null) =>
        R.Reviewer.value(ctx.id('codex-triage', round, shortfall ? 'retry' : 'first'), {
          ...place,
          prompt: prompts.TriageLocalReview({
            situation,
            standingNotes,
            sha: result.sha.slice(0, 12),
            file: result.file ?? '',
            findings: result.findings,
            known,
            round,
            ...roundCaps,
            shortfall,
          }),
          schema: CodexTriage,
        });
      let triage = await ask(null);
      if (!triage.ok) return { error: 'triage of the local Codex review returned nothing' };
      // Every tagged finding needs an entry, or one could merge unhandled. The count can overcount
      // (a tag quoted in prose), so a shortfall is retried once and then blocks only when triage
      // returned no finding at all; a partial shortfall is recorded in the notes instead.
      if (triage.value.findings.length < result.findings) {
        const covered = triage.value.findings;
        ctx.log(
          `Local Codex triage r${String(round)} covered ${String(covered.length)} of ${String(result.findings)} finding(s); retrying`,
        );
        triage = await ask({ covered: covered.length, ids: covered.map((f) => f.id) });
        if (!triage.ok)
          return { error: 'triage of the local Codex review returned nothing on retry' };
      }
      const decided = triage.value;
      if (!decided.findings.length)
        return {
          error: `triage of the local Codex review covered 0 of ${String(result.findings)} findings`,
        };
      if (decided.findings.length < result.findings)
        record.notes.push(
          `triage of the local Codex review in round ${String(round)} covered ${String(decided.findings.length)} of ${String(result.findings)} tagged finding(s); proceeding with those`,
        );
      if (decided.notes.length)
        record.triageNotes = [...(record.triageNotes ?? []), ...decided.notes];
      const findings = decided.findings.map((f) => ({
        ...f,
        id: `cx${String(round)}-${f.id}`,
        disposition: ['invalid', 'duplicate'].includes(f.verdict)
          ? ('note' as const)
          : f.disposition,
      }));
      for (const f of findings) {
        record.codexFindings.push({
          id: f.id,
          round,
          title: f.title,
          verdict: f.verdict,
          severity: f.severity,
          disposition: f.disposition,
          detail: f.detail,
          plan: f.plan,
        });
        findingsSeen.set(f.id, { title: f.title, disposition: f.disposition, verdict: f.verdict });
      }
      const work = itemsFrom([], findings, 'local Codex review');
      return { fix: work.fix, followup: work.followup, findings };
    };

    let review: Review | DependencyReview;
    let work: Work;
    if ('dependency' in firstReview) {
      review = firstReview.dependency;
      record.dependency = { decision: review.decision, rationale: review.rationale };
      record.headline = review.headline;
      if (review.decision === 'defer')
        return finish('deferred', { notes: [...record.notes, review.rationale] });
      if (review.decision === 'close') {
        if (!publishing) return finish('stopped', { plannedClose: review.closeComment });
        ctx.phase('Land');
        await gh.comment('close/comment', { number: A.pr, body: review.closeComment }, write);
        // Dependabot closes the PR itself after an "@dependabot ignore" command.
        const closed = await gh.waitPr('close/wait', {
          pr: A.pr,
          sha: PR.headRefOid,
          until: 'closed',
          timeoutMs: 90_000,
          every: 10_000,
        });
        if (closed.status === 'timeout')
          return blocked(
            'close',
            'the PR is still open 90 s after the closing comment; close it by hand',
          );
        if (closed.status === 'closed') return finish('closed');
        // Merged meanwhile (head-moved is a merge at another head while waiting for closure).
        record.mergeCommit = closed.mergeCommit;
        const at = `${String(closed.headRefOid)}${closed.mergeCommit ? `, merge commit ${closed.mergeCommit}` : ''}`;
        return blocked(
          'close',
          `the PR was merged (at ${at}) instead of closed after the closing comment`,
        );
      }
      const fixes: WorkItem[] = review.fixes.map((f) => ({
        key: `fix:${f.id}`,
        source: 'dependency review',
        title: f.title,
        severity: 'major',
        complexity: f.complexity,
        plan: f.plan,
        detail: '',
        files: [],
      }));
      work = { fix: [...fixes, ...checkItem(check0, 'check-0', false)], followup: [] };
    } else {
      let change = firstReview.change;
      const reasons = escalationReasons(change);
      if (reasons.length) {
        ctx.log(`Escalating review: ${reasons.join('; ')}`);
        const deep = await R.Judge.value('escalated-review', {
          ...place,
          prompt: prompts.EscalatedReview({
            situation,
            rebase,
            standingNotes,
            reasons,
            firstReview: JSON.stringify(change, null, 1),
          }),
          schema: Review,
        });
        if (deep.ok) {
          change = deep.value;
          reviewSummary.escalated = true;
        } else
          record.notes.push('escalated review returned nothing; kept the first-pass assessment');
      }
      review = change;
      Object.assign(reviewSummary, {
        alignment: change.alignment,
        issueDisposition: change.issueDisposition,
        summaryNotes: change.summaryNotes,
      });
      remember(change.threads, 0);
      const found = itemsFrom(change.threads, change.findings);
      reviewSummary.findings.push(...found.recorded);
      for (const f of found.recorded)
        findingsSeen.set(f.id, { title: f.title, disposition: f.disposition });
      const local =
        firstLocal !== null ? await triageLocal(firstLocal, 0) : { fix: [], followup: [] };
      if ('error' in local) return blocked('review', local.error);
      work = {
        fix: [
          ...found.fix,
          ...local.fix,
          ...checkItem(check0, 'check-0', SYNC.status === 'conflict'),
        ],
        followup: [...found.followup, ...local.followup],
      };
    }
    ctx.log(
      `Plan: ${String(work.fix.length)} fix item(s), ${String(work.followup.length)} follow-up(s)`,
    );
    if (A.until === 'review')
      return finish('stopped', { review, check: check0, plannedWork: planned(work) });

    // ── Fix (∥ follow-up filing) ────────────────────────────────────────────────────────────
    const team: FixTeam = FixTeam.from({
      mechanic: R.Mechanic,
      surgeon: R.Surgeon,
    });
    let fixRound = 0;
    let filings = 0;
    let epic: Promise<number> | null = null;

    // The follow-up epic, created on first use (the result's followupEpic carries it to later runs).
    const followupEpic = (): Promise<number> => {
      if (record.followupEpic !== null) return Promise.resolve(record.followupEpic);
      epic ??= gh.issue
        .create(
          'followups/epic',
          {
            title: A.followupEpicTitle,
            body: prompts.FollowupEpicBody({ parentEpic: A.parentEpic ?? null }).text,
          },
          write,
        )
        .then((created) => (record.followupEpic = created.number));
      return epic;
    };

    // The scribe drafts, the workflow files: each draft becomes a sub-issue of the follow-up epic,
    // or a comment on the open issue it duplicates.
    const fileFollowups = async (items: WorkItem[]): Promise<Filed | { error: string }> => {
      const batch = ++filings;
      const keys = items.map((i) => i.key) as [string, ...string[]];
      const drafted = await R.Scribe.value(ctx.id('followups', batch, 'draft'), {
        ...place,
        prompt: prompts.DraftFollowups({
          situation,
          epic: record.followupEpic,
          epicTitle: A.followupEpicTitle,
          items: items.map((i) => ({ ...i, files: [...i.files] })),
        }),
        schema: FollowupDrafts(keys),
      });
      if (!drafted.ok) return { error: 'the follow-up scribe returned nothing' };
      const drafts = canonicalizeKeys(items, drafted.value.items);
      const filed: Filed = [];
      for (const draft of drafts) {
        if (!keys.includes(draft.key) || filed.some((f) => f.key === draft.key)) continue;
        if (draft.duplicateOf !== null) {
          const comment = await gh.comment(
            ctx.id('followups', batch, 'comment', draft.key),
            { number: draft.duplicateOf, body: draft.duplicateComment || draft.body },
            write,
          );
          record.followups.push({
            key: draft.key,
            number: draft.duplicateOf,
            url: comment.url,
            title: draft.title,
            action: 'commented-existing',
          });
          filed.push({ key: draft.key, number: draft.duplicateOf });
          continue;
        }
        const parent = await followupEpic();
        const created = await gh.issue.create(
          ctx.id('followups', batch, 'issue', draft.key),
          {
            title: draft.title,
            body: `${draft.body.trimEnd()}${followupFooter(parent, A.pr)}`,
            labels: [draft.label],
            parent,
          },
          write,
        );
        record.followups.push({
          key: draft.key,
          number: created.number,
          url: created.url,
          title: draft.title,
          action: 'created',
        });
        filed.push({ key: draft.key, number: created.number });
      }
      return filed;
    };

    // The fixer's report, checked: every item reported, nothing unfinished but a deferrable minor
    // finding, and every fixed item backed by a commit that is in the branch.
    const settle = async (
      items: WorkItem[],
      reported: FixResult,
      label: string,
    ): Promise<{ report: FixResult; head: string } | { error: string }> => {
      const report = { ...reported, items: canonicalizeKeys(items, reported.items) };
      const keys = new Set(report.items.map((i) => i.key));
      const unreported = items.filter((i) => !keys.has(i.key)).map((i) => i.key);
      if (unreported.length)
        return { error: `implementer did not report: ${unreported.join(', ')}` };
      const open = unfixed(report.items, items);
      if (open.length)
        return { error: `could not fix: ${open.map((i) => `${i.key} (${i.summary})`).join('; ')}` };
      const commits = [...new Set(report.items.map((i) => i.commit.trim()).filter(Boolean))];
      const verified = await verifyFixes(ctx, ctx.id('fix', label, 'verify'), {
        workdir: W,
        commits,
      });
      if (!verified.ok) return { error: `could not verify fixes: ${verified.error.message}` };
      if (verified.value.missingCommits.length)
        return {
          error: `reported commits not in the branch: ${verified.value.missingCommits.join(', ')}`,
        };
      return { report, head: verified.value.head };
    };

    // Implement the fix items, then run the suite at the new head; a failing suite gets one repair
    // (mechanic, then surgeon) with its log. No head is published without a passing check there.
    const implement = async (
      items: WorkItem[],
    ): Promise<{ fixed: FixResult } | { error: string }> => {
      const n = ++fixRound;
      const hard =
        kind === 'change' &&
        items.some((i) => i.complexity === 'subtle' || i.severity === 'blocker');
      const keys = items.map((i) => i.key) as [string, ...string[]];
      const listed = items.map((i) => ({ ...i, files: [...i.files] }));
      // Another PR's run may have taken the root over since this run synced: no agent edits its
      // checkout, whichever session the agent runs in.
      const ask = async (
        agent: FixTeam['mechanic'],
        id: string,
        retry: boolean,
        repair: Parameters<typeof prompts.Implement>[0]['repair'],
      ) => {
        const owned = await ownedAgent(ctx, ctx.id('fix', n, id), owner, () =>
          agent.value(ctx.id('fix', n, id), {
            ...place,
            prompt: prompts.Implement({ situation, standingNotes, items: listed, retry, repair }),
            schema: Fix(keys),
          }),
        );
        return 'refused' in owned ? owned : owned.value;
      };
      const first = hard ? team.surgeon : team.mechanic;
      let answer = await ask(first, 'implement', false, null);
      if ('refused' in answer) return { error: answer.refused };
      if (!answer.ok) {
        // An implementer that ends without reporting may still have committed work; don't redo it.
        ctx.log(`fix-${String(n)}: implementer ended without a result; retrying once`);
        answer = await ask(first, 'implement-retry', true, null);
        if ('refused' in answer) return { error: answer.refused };
      }
      if (!answer.ok) return { error: 'implementer returned nothing' };
      let settled = await settle(items, answer.value, String(n));
      if ('error' in settled) return settled;
      let gate = await check(`fix-${String(n)}`);
      if (!gate.passed || gate.head !== settled.head) {
        ctx.log(
          `fix-${String(n)}: checks fail at ${settled.head.slice(0, 7)}; repairing with the surgeon tier`,
        );
        const repaired = await ask(team.surgeon, 'repair', false, {
          notes: JSON.stringify(settled.report.notes),
          head: settled.head,
          failedStep: gate.failedStep,
          log: gate.log ?? gate.error ?? 'no log',
          excerptFile: gate.excerptFile,
        });
        if ('refused' in repaired) return { error: repaired.refused };
        if (!repaired.ok)
          return {
            error: `local checks at ${settled.head.slice(0, 7)} after fixes failed, and the repair returned nothing (${String(gate.log)})`,
          };
        settled = await settle(items, repaired.value, `${String(n)}-repair`);
        if ('error' in settled) return settled;
        gate = await check(`fix-${String(n)}-repair`);
        if (!gate.passed || gate.head !== settled.head) {
          const why = gate.error ?? (gate.failedStep ? `${gate.failedStep} failed` : 'failed');
          const notes = settled.report.notes.length
            ? `; fixer notes: ${settled.report.notes.join('; ')}`
            : '';
          return {
            error: `local checks at ${settled.head.slice(0, 7)} after fixes: ${why}${gate.log ? ` (${gate.log})` : ''}${notes}`,
          };
        }
      }
      checkedHead = settled.head;
      return { fixed: settled.report };
    };

    // One fix round: implement and file follow-ups in parallel, defer unfinished minor findings,
    // and plan the thread replies. Returns the replies and whether the branch changed.
    const fixRoundOf = async (
      threads: readonly ThreadDecision[],
      round: Work,
    ): Promise<RoundResult> => {
      if (!round.fix.length && !round.followup.length)
        return { replies: threads.flatMap((t) => replyFor(t, null, null) ?? []), changed: false };
      ctx.phase('Fix');
      const [fixedResult, filedResult] = await Promise.all([
        round.fix.length ? implement(round.fix) : Promise.resolve(null),
        round.followup.length && publishing ? fileFollowups(round.followup) : Promise.resolve(null),
      ]);
      if (fixedResult && 'error' in fixedResult) return fixedResult;
      if (filedResult && 'error' in filedResult)
        return { error: `follow-up filing incomplete: ${filedResult.error}` };
      const fixed = fixedResult?.fixed ?? null;
      const filed = filedResult ?? [];
      if (round.followup.length && publishing) {
        const unfiled = round.followup
          .filter((i) => !filed.some((f) => f.key === i.key))
          .map((i) => i.key);
        if (unfiled.length) return { error: `follow-up filing incomplete: ${unfiled.join(', ')}` };
      }
      // A minor finding of this workflow's own review that the fixer could not fully address
      // becomes a follow-up instead of blocking, now that the round is otherwise sound.
      const deferred = (fixed?.items ?? []).filter((i) => deferrable(i, round.fix));
      if (deferred.length && fixed) {
        const items = deferred.flatMap((d) => {
          const item = round.fix.find((x) => x.key === d.key);
          if (item === undefined) return [];
          return {
            ...item,
            detail: deferredDetail({ item, report: d, pr: A.pr, notes: fixed.notes }),
          };
        });
        let filedDeferred: Filed = [];
        if (publishing) {
          const result = await fileFollowups(items);
          if ('error' in result)
            return { error: `could not file deferred findings: ${result.error}` };
          filedDeferred = result;
          const unfiled = items
            .filter((i) => !filedDeferred.some((f) => f.key === i.key))
            .map((i) => i.key);
          if (unfiled.length)
            return { error: `could not file deferred findings: ${unfiled.join(', ')}` };
        }
        record.deferredFindings = [
          ...(record.deferredFindings ?? []),
          ...deferred.map((d) => ({
            key: d.key,
            status: d.status,
            summary: d.summary,
            issue: filedDeferred.find((f) => f.key === d.key)?.number ?? null,
          })),
        ];
        ctx.log(
          `Deferred ${String(deferred.length)} minor finding(s) to follow-ups: ${deferred.map((d) => d.key).join(', ')}`,
        );
      }
      if (fixed?.notes.length) record.fixNotes = [...(record.fixNotes ?? []), ...fixed.notes];
      record.fixes = [...(record.fixes ?? []), ...(fixed?.items ?? [])];
      const replies = threads.flatMap((t) => replyFor(t, fixed?.items ?? null, filed) ?? []);
      const changed = (fixed?.items ?? []).some(
        (i) => i.status !== 'not-fixed' && i.commit.trim() !== '',
      );
      return { replies, changed };
    };

    const initialThreads = 'threads' in review ? review.threads : [];
    const firstRound = await fixRoundOf(initialThreads, work);
    if ('error' in firstRound) return blocked('fix', firstRound.error);
    if (A.until === 'fix') return finish('stopped', { review, plannedReplies: firstRound.replies });

    // ── Gate: publish, reply, wait; loop on new findings or red CI ──────────────────────────
    const codexAllowed = kind === 'change' && A.codex !== 'never';
    const ownCodeChanged = SYNC.status === 'conflict' || firstRound.changed;
    // Locally, the review stage already reviewed the head it saw, so only new commits need another
    // pass, unless that review failed. The GitHub app reviews the pushed head on request.
    let wantCodex =
      codexAllowed &&
      (A.codex === 'always' ||
        (LOCAL
          ? firstRound.changed || !firstLocalOk
          : ownCodeChanged || !prSummary.codex.reviewed));
    const disposition = 'issueDisposition' in review ? review.issueDisposition.action : 'none';
    const closesIssue = kind === 'change' && ISSUE !== null && disposition === 'close';
    // A PR body that says "Closes #N" would close an issue the review decided to keep open.
    const keepsIssueOpen = kind === 'change' && ISSUE !== null && disposition === 'keep-open';
    let replies = firstRound.replies;
    const rerunHeads = new Set<string>();
    let head = SYNC.origHead ?? PR.headRefOid;
    let base = PR.baseRefName;
    let codexRequests = 0;
    if (IGNORE_CI && publishing)
      record.notes.push(
        "GitHub CI was not consulted (ci: 'ignore'); the local check suite and the reviewers gated the merge",
      );

    // Retarget, push, confirm GitHub sees the head, fix the closing keyword, reply to threads.
    const publishRound = async (r: number): Promise<{ since: number } | { error: string }> => {
      if (checkedHead === null) return { error: 'no head passed the local checks' };
      // A stacked PR moves to the default branch before the push, so the checks the push starts run
      // against the base it will merge into.
      let retargeted = false;
      if (base !== DEF) {
        const moved = await gh.pr.edit(
          ctx.id('gate', r, 'retarget'),
          { number: A.pr, expectHead: head, base: DEF },
          write,
        );
        if (moved.reason !== null)
          return { error: `could not retarget the PR (${moved.reason}, head ${moved.head})` };
        base = DEF;
        retargeted = moved.changed.includes('base');
      }
      const pushed = await publish(ctx, ctx.id('gate', r, 'push'), {
        workdir: W,
        pr: A.pr,
        branch: PR.headRefName,
        expected: head,
        synced: reviewHead ?? head,
        sha: checkedHead,
      });
      if (!pushed.ok) return { error: pushed.error.message };
      if (retargeted && pushed.value.head === head)
        record.notes.push(
          `retargeted to ${DEF} with no new head to push, so CI was not re-triggered against the new base`,
        );
      head = pushed.value.head;
      const sha = head;
      // GitHub can report the old head for a while after a push; the waits pin the new one.
      const visible = await ctx.poll(ctx.id('gate', r, 'visible'), {
        input: { pr: A.pr, sha: head },
        schema: z.boolean(),
        command: [
          'gh',
          'api',
          `repos/${info.nameWithOwner}/pulls/${String(A.pr)}`,
          '--jq',
          '{sha: .head.sha}',
        ],
        output: z.object({ sha: z.string() }),
        done: (view: { sha: string }) =>
          view.sha === sha ? { done: true, value: true } : { done: false },
        every: 5_000,
        timeoutMs: 180_000,
      });
      if (visible.by === 'deadline')
        record.notes.push(
          `GitHub still showed an older head 3 minutes after the push of ${head.slice(0, 7)}`,
        );
      // The body as it is now, not as Prepare saw it: someone may have edited it since.
      const current =
        closesIssue || keepsIssueOpen
          ? (await gh.pr.view(ctx.id('gate', r, 'body'), { number: A.pr }, write)).body
          : PR.body;
      const body = closesIssue
        ? ensureClosesBody(current, ISSUE.number)
        : keepsIssueOpen
          ? keepOpenBody(current, ISSUE.number, info.nameWithOwner)
          : null;
      if (body !== null) {
        const edited = await gh.pr.edit(
          ctx.id('gate', r, 'edit'),
          { number: A.pr, expectHead: head, body },
          write,
        );
        if (edited.reason !== null)
          return { error: `could not edit the PR (${edited.reason}, head ${edited.head})` };
      }
      if (closesIssue) {
        // GitHub links a closing keyword shortly after the edit, or after the retarget.
        const issue = ISSUE.number;
        const linked = await ctx.poll(ctx.id('gate', r, 'linked'), {
          input: { pr: A.pr, issue },
          schema: z.boolean(),
          command: [
            'gh',
            'pr',
            'view',
            String(A.pr),
            '-R',
            info.nameWithOwner,
            '--json',
            'closingIssuesReferences',
          ],
          output: z.object({ closingIssuesReferences: z.array(z.object({ number: z.int() })) }),
          done: (view: { closingIssuesReferences: { number: number }[] }) =>
            view.closingIssuesReferences.some((i) => i.number === issue)
              ? { done: true, value: true }
              : { done: false },
          every: 2_000,
          timeoutMs: 30_000,
        });
        if (linked.by === 'deadline')
          record.notes.push(`issue #${String(issue)} is not linked as closing; land will verify`);
      }
      for (const reply of replies) {
        const alert = /^alert:(\d+)$/.exec(reply.threadId);
        const number = alert ? Number(alert[1]) : (threadInfo.get(reply.threadId)?.alert ?? null);
        if (!alert)
          await gh.thread.reply(
            ctx.id('gate', r, 'reply', reply.threadId),
            { threadId: reply.threadId, body: reply.body },
            write,
          );
        // A settled code-scanning alert must leave the open set: rejected ones are dismissed as false
        // positives (or used in tests), deferred ones as "won't fix".
        if (reply.dismiss && number !== null)
          await gh.alert.dismiss(
            ctx.id('gate', r, 'dismiss', number),
            {
              number,
              comment: reply.body,
              ...(reply.dismiss === 'defer' ? { reason: "won't fix" as const } : {}),
            },
            write,
          );
      }
      replies = [];
      // Before the request, so a review that answers it quickly still counts.
      const since = await ctx.now(ctx.id('gate', r, 'since'));
      if (wantCodex && !LOCAL)
        await gh.comment(
          ctx.id('gate', r, 'codex-request'),
          { number: A.pr, body: '@codex review' },
          write,
        );
      if (wantCodex) codexRequests++;
      record.codexReviewsRequested = codexRequests;
      return { since };
    };
    const blockedIf = (
      statuses: readonly { status: string; headRefOid: string | null }[],
      what: string,
    ): string | null => {
      const moved = statuses.find((s) => s.status === 'head-moved');
      if (moved)
        return `PR head moved to ${String(moved.headRefOid)} while waiting; someone else pushed`;
      if (statuses.some((s) => s.status === 'closed'))
        return `the PR closed while waiting for ${what}`;
      if (statuses.some((s) => s.status === 'timeout')) return `timed out waiting for ${what}`;
      return null;
    };

    for (;;) {
      record.rounds++;
      const r = record.rounds;
      if (r > A.codexRoundsHardCap + 3)
        return blocked('gate', `still unsettled after ${String(r - 1)} review rounds`);
      ctx.phase('Gate');
      const published = await publishRound(r);
      if ('error' in published) return blocked('publish', published.error);
      const githubCodex = wantCodex && !LOCAL;
      const bound = { pr: A.pr, sha: head, timeoutMs: 2 * HOUR, staleGraceMs: 90_000 };
      const required = A.requiredChecks.length ? { requiredChecks: A.requiredChecks } : {};
      const waitAll = (tag: string, reviewers: Parameters<typeof gh.waitReview>[1]['reviewers']) =>
        Promise.all([
          IGNORE_CI
            ? Promise.resolve(ciNotConsulted(bound.sha))
            : gh.waitChecks(ctx.id('gate', r, tag, 'ci'), { ...bound, ...required }),
          gh.waitReview(ctx.id('gate', r, tag, 'review'), {
            ...bound,
            since: published.since,
            reviewers,
          }),
        ]);
      const [[ci0, reviewed0], localReview] = await Promise.all([
        waitAll('wait', githubCodex ? [codexReviewer(), scanner()] : [scanner()]),
        wantCodex && LOCAL ? reviewAt(`r${String(r)}`, head) : Promise.resolve(null),
      ]);
      const early =
        blockedIf([ci0, reviewed0], 'CI and reviews') ??
        unregisteredRequired(ci0, A.requiredChecks);
      if (early) return blocked('gate', early);
      // Either the local review or CI can outlast the reviewer wait, so threads and alerts can
      // arrive meanwhile: read the gate again, which costs only the settle delay now that both are
      // done.
      const [ci, reviewed] = await waitAll('refresh', [scanner()]);
      const late =
        blockedIf([ci, reviewed], 'the refreshed gate') ??
        unregisteredRequired(ci, A.requiredChecks);
      if (late) return blocked('gate', late);
      const codexVerdict = reviewed0.by.find((b) => b.name === 'codex')?.status ?? null;
      ctx.log(
        `Round ${String(r)}: CI ${ci.status}; Codex ${LOCAL ? (wantCodex ? `local, ${localReview?.error ? 'failed' : `${String(localReview?.findings ?? 0)} finding(s)`}` : 'not run') : String(codexVerdict)}`,
      );
      let ciFailed = ci.status === 'failure';
      let failedChecks = ci.failed.map((f) => f.name);
      if (githubCodex && codexVerdict === 'error')
        record.notes.push(`Codex review errored in round ${String(r)}; proceeding on CI`);
      // GitHub Codex findings arrive as threads; local ones as a review file triaged separately.
      const codexFindings = githubCodex && codexVerdict === 'findings';
      const localFindings = localReview?.error === null && localReview.findings > 0;
      // Anything else unanswered: code-scanning threads or alerts, other bots, humans.
      const attention = reviewed.untriagedThreads.length + reviewed.openAlerts.length;
      let needsTriage = codexFindings || attention > 0;
      if (attention && !codexFindings)
        ctx.log(
          `Round ${String(r)}: ${String(attention)} unanswered thread(s)/alert(s) need triage`,
        );
      if (ciFailed && !needsTriage && !rerunHeads.has(head)) {
        // Red CI on a head we are not about to replace: rerun the failed jobs once before paying an
        // agent to "fix" what may be a flake in code this PR never touched.
        rerunHeads.add(head);
        const rerun = await gh.checks.rerunFailed(
          ctx.id('gate', r, 'rerun-failed'),
          { sha: head },
          write,
        );
        // Wait whatever the rerun did: when it found the failed jobs already re-run (a reconciled
        // rerun), the CI it left behind may have passed since the gate read it, and when nothing
        // changed the wait returns at once with the same failure.
        const [again, againReview] = await waitAll('rerun', [scanner()]);
        const stuck =
          blockedIf([again, againReview], 'the re-run CI') ??
          unregisteredRequired(again, A.requiredChecks);
        if (stuck) return blocked('gate', stuck);
        const flaky = again.status === 'success' || again.status === 'no-checks';
        const action = rerun.rerun.length ? 're-ran' : 'found already re-run';
        record.notes.push(
          `CI failed on ${failedChecks.join(', ')}; ${action} the failed jobs: ${flaky ? 'passed (flaky)' : 'failed again'}`,
        );
        if (flaky) {
          record.flakyChecks = [...(record.flakyChecks ?? []), ...failedChecks];
          ciFailed = false;
        } else failedChecks = again.failed.map((f) => f.name);
        // Threads can arrive while the re-run is pending.
        const lateAttention = againReview.untriagedThreads.length + againReview.openAlerts.length;
        if (lateAttention) {
          needsTriage = true;
          ctx.log(
            `Round ${String(r)}: ${String(lateAttention)} thread(s)/alert(s) arrived during the CI re-run`,
          );
        }
      }
      if (!ciFailed && !needsTriage && !localFindings) {
        if (localReview) {
          const local = await triageLocal(localReview, codexRequests);
          if ('error' in local) return blocked('review', local.error);
        }
        break;
      }

      let threads: ThreadDecision[] = [];
      const roundWork: Work = { fix: [], followup: [] };
      let localTriaged: { severity: string; verdict: string }[] = [];
      if (localReview) {
        const local = await triageLocal(localReview, codexRequests);
        if ('error' in local) return blocked('review', local.error);
        roundWork.fix.push(...local.fix);
        roundWork.followup.push(...local.followup);
        localTriaged = local.findings;
      }
      if (needsTriage) {
        ctx.phase('Review');
        const fresh = await readThreads(ctx, gh, { number: A.pr, paths, key: `r${String(r)}` });
        for (const t of fresh.threads) threadInfo.set(t.id, t);
        const settled = record.threads.map((t) => `- ${t.title}: ${t.verdict}, ${t.action}`);
        const triage = await R.Reviewer.value(ctx.id('gate', r, 'triage'), {
          ...place,
          prompt: prompts.TriageThreads({
            situation,
            standingNotes,
            codexFindings,
            settled,
            laterInStack: prepared.later.length > 0,
            round: codexRequests,
            ...roundCaps,
          }),
          schema: Triage,
        });
        if (!triage.ok) return blocked('review', 'thread triage returned nothing');
        threads = triage.value.threads;
        remember(threads, r);
        if (triage.value.notes.length)
          record.triageNotes = [...(record.triageNotes ?? []), ...triage.value.notes];
        const found = itemsFrom(threads, []);
        roundWork.fix.push(...found.fix);
        roundWork.followup.push(...found.followup);
      }
      if (ciFailed) {
        record.ciRepairs++;
        if (record.ciRepairs > A.maxCiRepairs)
          return blocked(
            'gate',
            `CI still failing after ${String(A.maxCiRepairs)} repair attempts: ${failedChecks.join(', ')}`,
          );
        roundWork.fix.push(
          ciItem({
            round: r,
            failed: failedChecks,
            pr: A.pr,
            repo: info.nameWithOwner,
            rerun: rerunHeads.has(head),
          }),
        );
      }
      const next = await fixRoundOf(threads, roundWork);
      if ('error' in next) return blocked('fix', next.error);
      replies = next.replies;
      // Codex reports a few findings per pass, so intricate PRs show a long tail of real problems.
      // Past the base limit, keep asking only while the latest round still found something major.
      const major = latestMajor([...threads, ...localTriaged]);
      wantCodex =
        codexAllowed &&
        next.changed &&
        underLimit({
          requests: codexRequests,
          maxCodexRounds: A.maxCodexRounds,
          hardCap: A.codexRoundsHardCap,
          latestMajor: major,
        });
      if (codexRequests >= A.maxCodexRounds && wantCodex)
        record.notes.push(
          `Codex round ${String(codexRequests)} found a major problem; requesting another review`,
        );
      if ((codexFindings || localFindings) && next.changed && !wantCodex)
        record.notes.push(
          major
            ? `Codex hard cap (${String(A.codexRoundsHardCap)}) reached with a major finding in the last round; its fixes were gated on CI only`
            : `Codex round limit reached after round ${String(codexRequests)} (latest findings minor); the last fixes were gated on CI only`,
        );
      // Triage that changed nothing still has replies to publish, and the failed jobs deserve their
      // one re-run on this head before anyone concludes the failure is real.
      if (ciFailed && !next.changed && rerunHeads.has(head))
        return blocked('gate', 'CI failed and the repair made no changes');
    }

    // ── Land ────────────────────────────────────────────────────────────────────────────────
    ctx.phase('Land');
    // The gate's CI success can be hours old (review waits and fix rounds run after it), and a
    // re-run, a new required check or a base update may have turned it red since: read CI again.
    const landCi = IGNORE_CI
      ? ciNotConsulted(head)
      : await gh.waitChecks(ctx.id('land', 'ci', head), {
          pr: A.pr,
          sha: head,
          timeoutMs: 2 * HOUR,
          staleGraceMs: 90_000,
          ...(A.requiredChecks.length ? { requiredChecks: A.requiredChecks } : {}),
        });
    const landCiBlock =
      blockedIf([landCi], 'CI before landing') ?? unregisteredRequired(landCi, A.requiredChecks);
    if (landCiBlock) return blocked('land', landCiBlock);
    if (landCi.status === 'failure')
      return blocked(
        'land',
        `CI failed before landing: ${landCi.failed.map((f) => f.name).join(', ')}`,
      );
    // The guards (open, head, base, CI, unanswered threads, open alerts) and the REST merge pinned
    // to the gated head (never auto-merge or a merge queue) are one step. Every attempt of it, a
    // retry's or a resumed run's included, rereads the guards right before the merge, so a merge
    // never rests on reads checkpointed before an earlier attempt failed.
    const landed = await landMerge(ctx, ctx.id('land', 'merge', head), {
      repo,
      pr: A.pr,
      head,
      base: DEF,
      viewer: info.viewer,
      requiredChecks: A.requiredChecks,
      ...(A.mergeMethod === 'squash' ? {} : { method: A.mergeMethod }),
      ...(IGNORE_CI ? { ignoreCi: true as const } : {}),
    });
    if (!landed.merged) return blocked('land', landed.reason);
    const mergeCommit = landed.mergeCommit ?? 'unknown';
    record.mergeCommit = mergeCommit;
    if (kind === 'change' && ISSUE && record.issue) {
      let state: string;
      let closedManually = false;
      if (closesIssue) {
        const closed = await ctx.poll('land/issue-closed', {
          input: { issue: ISSUE.number },
          schema: z.literal('closed'),
          command: [
            'gh',
            'api',
            `repos/${info.nameWithOwner}/issues/${String(ISSUE.number)}`,
            '--jq',
            '{state: .state}',
          ],
          output: z.object({ state: z.string() }),
          done: (issue: { state: string }) =>
            issue.state === 'closed' ? { done: true, value: 'closed' as const } : { done: false },
          every: 3_000,
          timeoutMs: 60_000,
        });
        if (closed.by === 'poll') state = 'CLOSED';
        else {
          const result = await gh.issue.close(
            'land/issue-close',
            { number: ISSUE.number, comment: closedNote(A.pr, mergeCommit), reason: 'completed' },
            write,
          );
          state = result.state;
          closedManually = result.acted;
          if (closedManually)
            record.notes.push(
              `issue #${String(ISSUE.number)} did not auto-close; closed explicitly`,
            );
        }
      } else if (keepsIssueOpen) {
        // Commit messages can still carry a closing keyword; give GitHub a moment, then undo it.
        await ctx.sleep('land/settle', 5_000);
        const reopened = await gh.issue.reopen(
          'land/issue-reopen',
          { number: ISSUE.number, comment: reopenNote(A.pr) },
          write,
        );
        state = reopened.state;
      } else {
        state = (await gh.issue.view('land/issue', { number: ISSUE.number }, write)).state;
      }
      Object.assign(record.issue, { state, closedManually });
    }
    // GitHub deletes the merged head branch and retargets children shortly after the merge.
    if (prepared.children.length) {
      await ctx.sleep('land/retarget', 10_000);
      record.children = [];
      for (const child of prepared.children) {
        const c = await gh.pr.view(
          ctx.id('land', 'child', child.number),
          { number: child.number },
          write,
        );
        record.children.push({ pr: child.number, state: c.state, base: c.baseRefName });
      }
    }
    await cleanupBranch(ctx, 'land/cleanup', { workdir: W, branch: SYNC.localBranch });
    ctx.log(`Merged #${String(A.pr)} as ${mergeCommit.slice(0, 7)}`);

    // ── Report ──────────────────────────────────────────────────────────────────────────────
    if (kind === 'change' && ISSUE && 'issueDisposition' in review) {
      ctx.phase('Report');
      const facts = {
        pr: { number: A.pr, title: PR.title, mergeCommit },
        issue: {
          number: ISSUE.number,
          disposition: review.issueDisposition,
          stateAfterMerge: record.issue?.state ?? null,
        },
        rebase: record.rebase,
        alignment: review.alignment,
        threads: record.threads,
        fixes: record.fixes ?? [],
        findings: reviewSummary.findings,
        codexFindings: record.codexFindings,
        followups: record.followups,
        summaryNotes: review.summaryNotes,
        escalatedReview: reviewSummary.escalated,
        codexReviewsRequested: codexRequests,
        notes: record.notes,
      };
      const report = await R.Scribe.value('report', {
        ...place,
        prompt: prompts.IssueSummary({
          issue: ISSUE.number,
          repo: info.nameWithOwner,
          pr: A.pr,
          title: PR.title,
          base: DEF,
          mergeCommit: mergeCommit.slice(0, 7),
          method: A.mergeMethod,
          facts: std.exec.json(facts),
        }),
        schema: Report,
      });
      if (report.ok) {
        record.headline = report.value.headline || null;
        if (report.value.post && report.value.body.trim()) {
          const posted = await gh.comment(
            'report/comment',
            { number: ISSUE.number, body: report.value.body },
            write,
          );
          record.summaryCommentUrl = posted.url;
        }
      } else record.notes.push('the report scribe returned nothing; no summary was posted');
    }
    if (kind === 'dependency' && record.fixes?.length) {
      const fixes = record.fixes.map((f) => f.summary).join(' ');
      record.headline = `${record.headline ?? ''} During merge-down: ${fixes}`.trim();
    }
    if (!record.headline) {
      const lead =
        'summaryNotes' in review
          ? (review.summaryNotes[0] ?? review.alignment.notes.split('. ')[0] ?? '')
          : '';
      record.headline = fallbackHeadline({
        kind,
        fixes: record.fixes ?? [],
        threads: record.threads,
        codexRequests,
        lead,
      });
    }
    return finish('merged');
  },
});
