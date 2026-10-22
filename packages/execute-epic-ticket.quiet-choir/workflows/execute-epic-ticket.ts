// execute-epic-ticket: take one ticket of an epic from "open issue" to "merged". Control flow
// only: the prose is in prompts/, the agents in roster.ts, the contracts in contracts.ts and the
// mechanics in lib/. Stages: Survey, Plan, Implement, Publish, Land (merge-down-pr as a typed inline
// child) and Report. When there is nothing to implement, it says why: the epic is done, nothing is
// ready, the ticket is obsolete, or a question needs the maintainer.
import { join } from 'node:path';
import { defineWorkflow } from 'quiet-choir';
import {
  codexReviewer,
  github,
  nextTicket,
  outsideReferences,
  type GithubIssue,
  type GithubIssueWithComments,
} from 'quiet-choir/github';
import { MergeDownInput } from '../../merge-down.quiet-choir/contracts.js';
import { resolveRepo } from '../../merge-down.quiet-choir/lib/prepare.js';
import mergeDownPr from '../../merge-down.quiet-choir/workflows/merge-down-pr.js';
import {
  EpicTicketInput,
  EpicTicketResult,
  Implemented,
  Plan,
  PrText,
  Skeptic,
  STAGES,
  Writeups,
  type ImplementedResult,
  type PlanBody,
  type Stage,
  type Started,
} from '../contracts.js';
import { runCheck, type CheckResult } from '../lib/checks.js';
import { publish, resolvePaths, snapshot, start, ticketDir, verify } from '../lib/git.js';
import {
  addLabel,
  appendLedger,
  ensureLabel,
  findOpenIssueByTitle,
  insertChecklist,
  issueState,
  linkSubIssue,
  removeLabel,
  tick,
} from '../lib/github.js';
import {
  branchPrefix,
  candidates,
  closeReason,
  counts,
  DECISION_LABEL,
  firstSentence,
  followupFooter,
  HOLD_LABELS,
  implementerSlot,
  itemStatuses,
  landingNotes,
  ledgerLine,
  plain,
  prBody,
  shaCommits,
  stillHeld,
  unsettled,
  waitingHeadline,
  withDependency,
  withFollowups,
  type Candidate,
} from '../lib/policy.js';
import { renderEpic, renderIssue } from '../lib/state.js';
import { ImplementTeam } from '../lib/teams.js';
import { prompts, type Situation } from '../prompts.js';
import { roster } from '../roster.js';

type Ledger = EpicTicketResult;
type Status = Ledger['status'];
type Filed = Ledger['followups'][number];
/** The pull request the run lands. */
interface Target {
  readonly pr: number;
  readonly url: string;
  readonly head: string;
  readonly since: number | null;
  readonly inFlight: boolean;
}
/** What an implementation round leaves. */
type Outcome =
  | { readonly report: ImplementedResult; readonly head: string; readonly ahead: number }
  | { readonly problems: string; readonly check: CheckResult | null };

const MINUTE = 60_000;
const read = { retry: { maxAttempts: 3, on: ['process', 'timeout'] as const } };
const write = read;
const refs = (numbers: readonly number[]): string => numbers.map((n) => `#${String(n)}`).join(', ');

export default defineWorkflow({
  name: 'execute-epic-ticket',
  version: '1',
  description:
    'Find and execute one ticket from an epic: pick the next ready ticket, check it is still valid and plan it, implement it in a dedicated worktree, open a PR, land it via merge-down-pr, tick the epic — or report the epic done, stalled, or waiting on a decision',
  whenToUse:
    'Burning down an epic one ticket per run, in the order its checklist gives. Input: {epic, ticket?, decision?, until?, followupEpic?, standingNotes?, repo?}.',
  input: EpicTicketInput,
  output: EpicTicketResult,
  roster,
  prompts: [prompts],
  children: [mergeDownPr],
  async run(ctx, A) {
    const E = A.epic;
    const reach = (stage: Stage): boolean => STAGES.indexOf(A.until) >= STAGES.indexOf(stage);
    // GitHub writes (comments, labels, closes, filings, pushes, PRs, merges) start at 'pr'.
    const publishing = reach('pr');
    const record: Ledger = {
      epic: E,
      epicTitle: null,
      status: 'stopped',
      ticket: null,
      pr: null,
      plan: null,
      implementer: null,
      landing: null,
      followups: [],
      followupEpic: A.followupEpic ?? null,
      slices: [],
      decision: null,
      skipped: [],
      remaining: null,
      next: null,
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

    // ── Survey ──────────────────────────────────────────────────────────────────────────────
    ctx.phase('Survey');
    const repo = await resolveRepo(ctx, A.repo);
    const gh = github(ctx, { repo });
    const info = await gh.repo.info('repo-info', read);
    const DEF = info.defaultBranch;
    if (DEF === null) return blocked('survey', `${repo} has no default branch`);
    const paths = await resolvePaths(ctx, A.root, E);
    // The snapshot is frozen within a run, which pins the candidate; a new run reads it again.
    const survey = async (...key: string[]) => {
      const snap = await gh.epic.snapshot(
        ctx.id(...key, 'epic', E),
        { number: E, headRefPrefix: `${branchPrefix(E)}/` },
        read,
      );
      const outside: GithubIssue[] = [];
      for (const number of outsideReferences(snap))
        outside.push(await gh.issue.view(ctx.id(...key, 'outside', number), { number }, read));
      return { snap, selection: nextTicket(snap, { outside, holdLabels: [...HOLD_LABELS] }) };
    };
    const { snap, selection } = await survey('survey');
    record.epicTitle = snap.epic.title;
    const surveyCounts = counts(snap.items, selection);
    record.remaining = surveyCounts;
    ctx.log(
      `#${String(E)} ${snap.epic.title}: ${String(surveyCounts.open)} open of ${String(surveyCounts.total)} (${String(surveyCounts.ready)} ready, ${String(surveyCounts.inFlight)} in flight, ${String(surveyCounts.waiting)} waiting, ${String(surveyCounts.held)} held)`,
    );
    if (selection.done)
      return finish('epic-done', {
        headline: `Epic #${String(E)} has no open tickets left; close it when ready.`,
      });
    const list = candidates(selection, snap.items, A.ticket ?? null, A.maxCandidates);
    const first = list[0];
    if (first === undefined && A.ticket !== undefined)
      return blocked('survey', `#${String(A.ticket)} is not an open ticket of epic #${String(E)}`);
    if (first === undefined) return finish('stalled', { headline: waitingHeadline(E, selection) });
    if (A.until === 'survey')
      return finish('stopped', {
        ticket: { number: first.number, title: first.title, status: first.status },
        candidates: list.map((c) => c.number),
        headline: `Next in #${String(E)}: #${String(first.number)} ${first.title} (${first.status}).`,
      });

    // The epic body and the survey time, for epic.md; read once, when a ticket first needs them.
    let epicDoc: Promise<{ issue: GithubIssue; at: string }> | null = null;
    const epicState = () =>
      (epicDoc ??= Promise.all([
        gh.issue.view(ctx.id('survey', 'epic-body', E), { number: E }, read),
        ctx.now(ctx.id('survey', 'at')),
      ]).then(([issue, at]) => ({ issue, at: new Date(at).toISOString() })));

    // The follow-up epic, found by title or created on first need; the result carries it on.
    let followupEpicNumber: Promise<number> | null = null;
    const ensureFollowupEpic = (): Promise<number> => {
      if (record.followupEpic !== null) return Promise.resolve(record.followupEpic);
      followupEpicNumber ??= (async () => {
        const title = A.followupEpicTitle;
        const found = await findOpenIssueByTitle(ctx, ctx.id('followup-epic', 'find'), {
          repo,
          title,
        });
        const number =
          found?.number ??
          (
            await gh.issue.create(
              ctx.id('followup-epic', 'create'),
              {
                title,
                body: prompts.FollowupEpicBody({ epic: E, epicTitle: snap.epic.title }).text,
              },
              write,
            )
          ).number;
        if (found === null) ctx.log(`Created follow-up epic #${String(number)}`);
        record.followupEpic = number;
        return number;
      })();
      return followupEpicNumber;
    };

    // ── One candidate at a time ─────────────────────────────────────────────────────────────
    let target: Target | null = null;
    let worked: Candidate = first;
    let planFile: string | null = null;
    for (const c of list) {
      const n = c.number;
      const id = (...parts: (string | number)[]): string => ctx.id('ticket', n, ...parts);
      worked = c;
      record.ticket = { number: n, title: c.title, status: c.status };
      ctx.log(`Ticket #${String(n)} ${c.title} (${c.status})`);

      if (c.status === 'closed')
        return finish('stopped', { headline: `#${String(n)} is already closed.` });
      if (c.status === 'waiting')
        return finish('stalled', { headline: `#${String(n)} waits on ${refs(c.waitingOn)}.` });
      if (c.status === 'split')
        return finish('split', {
          headline: `#${String(n)} is split; its open slices are ${refs(c.openSlices)}.`,
        });
      if (c.status === 'close-split') {
        if (!publishing)
          return finish('stopped', {
            headline: `#${String(n)}'s slices have all closed; would close it.`,
          });
        ctx.phase('Plan');
        await gh.issue.close(
          id('close-split'),
          {
            number: n,
            comment: prompts.CloseSplitComment({ slices: [...c.split] }).text,
            reason: 'completed',
          },
          write,
        );
        await tick(ctx, id('tick'), { repo, epic: E, ticket: n });
        return finish('closed-split', {
          headline: `Closed #${String(n)}: all of its slices have landed.`,
        });
      }
      const decisionPending = c.labels.includes(DECISION_LABEL);
      if (stillHeld(c, A.decision ?? null))
        return finish('held', {
          headline: `#${String(n)} is held (${c.labels.join(', ')})${decisionPending ? '; rerun with decision once the question on it is answered' : ''}.`,
        });
      if (A.decision !== undefined && publishing) {
        // Record the answer durably on the ticket: later planners and the landing review read it.
        await gh.comment(
          id('decision'),
          { number: n, body: prompts.DecisionComment({ decision: A.decision }).text },
          write,
        );
        await removeLabel(ctx, id('decision', 'label'), { repo, number: n, label: DECISION_LABEL });
      }

      if (c.status === 'in-flight') {
        // An open PR already carries this ticket: go straight to landing.
        if (c.pr === null)
          return blocked('survey', `#${String(n)} is in flight without an open PR`);
        if (!publishing)
          return finish('stopped', {
            headline: `#${String(n)} already has PR #${String(c.pr)}; would land it.`,
          });
        const open = await gh.pr.view(id('pr-view'), { number: c.pr }, read);
        if (open.isDraft)
          return blocked(
            'survey',
            `PR #${String(c.pr)} for #${String(n)} is a draft; finish or undraft it first`,
          );
        target = { pr: c.pr, url: open.url, head: open.headRefOid, since: null, inFlight: true };
        break;
      }

      // ── Plan ──────────────────────────────────────────────────────────────────────────────
      ctx.phase('Plan');
      const dir = ticketDir(paths, n);
      const ticketDoc: GithubIssueWithComments = await gh.issue.view(
        id('issue'),
        { number: n, comments: true },
        read,
      );
      const epicNow = await epicState();
      const save = (name: string, content: string) =>
        ctx.writeFile(id('state', name), join(dir, name), content, { allowOutsideCwd: true });
      await save('issue.md', renderIssue(ticketDoc));
      await save(
        'epic.md',
        renderEpic(
          { ...epicNow.issue, state: snap.epic.state },
          snap.items,
          itemStatuses(selection),
          epicNow.at,
        ),
      );
      const started: Started = await start(ctx, id('start'), {
        paths,
        dir,
        base: DEF,
        epic: E,
        ticket: n,
        title: c.title,
      });
      if (started.refused !== null) return blocked('start', started.refused);
      if (started.rebase === 'conflict')
        return blocked(
          'start',
          `branch ${started.branch} from an earlier run no longer rebases cleanly onto origin/${DEF}; resolve it by hand or delete the branch`,
        );
      const W = paths.workdir;
      const place = { cwd: W, addDirs: [dir], onError: 'return' } as const;
      const situation = (file: string | null): Situation => ({
        repo,
        epic: { number: E, title: snap.epic.title },
        ticket: { number: n, title: c.title },
        branch: started.branch,
        worktree: W,
        base: DEF,
        dir,
        planFile: file,
      });

      const planTicket = async (replan: { kind: string; check: string } | null) => {
        const planned = await ctx.roster.Planner.value(id('plan', replan ? 'again' : 'first'), {
          ...place,
          prompt: prompts.Plan({
            situation: situation(started.planFile),
            standingNotes: A.standingNotes,
            checkCommand: A.checkCommand,
            earlier: started.resumed
              ? { ahead: started.ahead, planFile: started.planFile, dirty: started.dirty.length }
              : null,
            decision: A.decision ?? null,
            replan,
          }),
          schema: Plan,
        });
        if (!planned.ok) return null;
        record.plan = { readiness: planned.value.readiness, rationale: planned.value.rationale };
        ctx.log(`#${String(n)}: ${planned.value.readiness}`);
        return planned.value;
      };
      let verdict = await planTicket(null);
      if (verdict === null) return blocked('plan', 'planner returned nothing');

      // Closing a ticket on one model's word is how work gets lost: an independent skeptic must
      // agree, or the ticket is planned again with the skeptic's findings.
      if (verdict.readiness === 'obsolete') {
        const checked = await ctx.roster.Skeptic.value(id('skeptic'), {
          ...place,
          prompt: prompts.Skeptic({
            situation: situation(null),
            kind: verdict.obsoleteKind,
            rationale: verdict.rationale,
          }),
          schema: Skeptic,
        });
        const skeptic = checked.ok
          ? checked.value
          : { agree: false, evidence: 'the skeptic returned nothing', remaining: [] };
        if (skeptic.agree) {
          if (!publishing)
            return finish('stopped', {
              plannedClose: verdict.issueComment,
              headline: `#${String(n)} is obsolete (${verdict.obsoleteKind}); would close it.`,
            });
          const reason = closeReason(verdict.obsoleteKind);
          await gh.issue.close(
            id('close'),
            {
              number: n,
              reason,
              ...(verdict.issueComment.trim() ? { comment: verdict.issueComment } : {}),
            },
            write,
          );
          if (reason === 'completed') await tick(ctx, id('tick'), { repo, epic: E, ticket: n });
          return finish('closed-obsolete', {
            headline: `Closed #${String(n)} "${c.title}" as ${verdict.obsoleteKind}: ${firstSentence(verdict.rationale)}.`,
          });
        }
        ctx.log(`Skeptic disagrees that #${String(n)} is obsolete; re-planning the remaining work`);
        record.notes.push(
          `not obsolete after all: ${skeptic.remaining.join('; ') || skeptic.evidence}`,
        );
        verdict = await planTicket({ kind: verdict.obsoleteKind, check: JSON.stringify(skeptic) });
        if (verdict === null) return blocked('plan', 'planner returned nothing');
        if (verdict.readiness === 'obsolete')
          return blocked(
            'plan',
            `planner and skeptic disagree on whether #${String(n)} is obsolete`,
          );
      }

      if (verdict.readiness === 'needs-decision') {
        const question = verdict.decision;
        record.decision = { ticket: n, ...question };
        if (!publishing)
          return finish('stopped', {
            headline: `#${String(n)} needs a decision: ${question.question}`,
          });
        const posted = await gh.comment(
          id('ask'),
          { number: n, body: verdict.issueComment.trim() || question.question },
          write,
        );
        await ensureLabel(ctx, id('ask', 'ensure-label'), { repo, label: DECISION_LABEL });
        await addLabel(ctx, id('ask', 'add-label'), { repo, number: n, label: DECISION_LABEL });
        return finish('needs-decision', {
          headline: `#${String(n)} "${c.title}" needs a decision: ${question.question}`,
          notes: [...record.notes, `question posted: ${posted.url}`],
        });
      }

      if (verdict.readiness === 'blocked') {
        record.skipped.push({ number: n, blockedBy: verdict.blockedBy, why: verdict.rationale });
        if (publishing && verdict.issueComment.trim())
          await gh.comment(id('deps'), { number: n, body: verdict.issueComment }, write);
        ctx.log(
          `#${String(n)} is blocked by ${refs(verdict.blockedBy)}; trying the next candidate`,
        );
        continue;
      }

      if (verdict.readiness === 'split') {
        const slices = verdict.slices;
        record.slices = slices.map((s) => ({ title: s.title }));
        if (!publishing)
          return finish('stopped', {
            plannedSlices: slices,
            headline: `#${String(n)} would be split into ${String(slices.length)} slices.`,
          });
        const keys = slices.map((_, i) => `slice-${String(i + 1)}`);
        const written = keys.length
          ? await ctx.roster.Scribe.value(id('slices'), {
              ...place,
              prompt: prompts.WriteSlices({
                situation: situation(null),
                rationale: verdict.rationale,
                slices: JSON.stringify(slices, null, 1),
              }),
              schema: Writeups(keys as [string, ...string[]]),
            })
          : null;
        const writeups = keys.map((key) =>
          written?.ok ? written.value.issues.find((w) => w.key === key) : undefined,
        );
        if (!keys.length || writeups.some((w) => w === undefined))
          return blocked('split', 'slice write-ups missing or incomplete');
        const filed: { number: number; title: string }[] = [];
        for (const [i, w] of writeups.entries()) {
          if (w === undefined) continue;
          const body = withDependency(
            w.body,
            slices[i]?.dependsOnPrevious ? filed.at(-1)?.number : undefined,
          );
          const found = await findOpenIssueByTitle(ctx, id('slice', i + 1, 'find'), {
            repo,
            title: w.title,
          });
          if (found !== null) {
            // An earlier run's slice, perhaps filed before its parent link: only a sub-issue of
            // the epic is selectable, so link it before the split is recorded.
            const linked = await linkSubIssue(ctx, id('slice', i + 1, 'link'), {
              repo,
              parent: E,
              number: found.number,
            });
            if (linked.conflict !== null)
              return blocked(
                'split',
                `#${String(found.number)} matches slice title but already belongs to ${linked.conflict}`,
              );
          }
          const number =
            found?.number ??
            (
              await gh.issue.create(
                id('slice', i + 1, 'file'),
                { title: w.title, body, labels: [w.label], parent: E },
                write,
              )
            ).number;
          filed.push({ number, title: w.title });
        }
        await insertChecklist(ctx, id('checklist'), { repo, epic: E, parent: n, entries: filed });
        await gh.comment(
          id('split-marker'),
          {
            number: n,
            body: prompts.SplitComment({
              issueComment: verdict.issueComment.trim(),
              slices: filed.map((f) => f.number),
              rationale: verdict.rationale.trim(),
            }).text,
          },
          write,
        );
        return finish('split', {
          slices: filed,
          headline: `Split #${String(n)} "${c.title}" into ${refs(filed.map((f) => f.number))}; the next run takes #${String(filed[0]?.number ?? 0)}.`,
        });
      }

      // Ready: keep the plan beside the branch, so a later run (or a human) can pick it up.
      const plan: PlanBody = verdict.plan;
      const ids = plan.acceptance.map((a) => a.id);
      const [firstId, ...otherIds] = ids;
      if (firstId === undefined) return blocked('plan', 'the plan lists no acceptance criteria');
      planFile = join(dir, 'plan.json');
      await ctx.writeFile(id('state', 'plan.json'), planFile, JSON.stringify(plan, null, 2), {
        allowOutsideCwd: true,
      });
      record.plan = {
        ...record.plan,
        readiness: verdict.readiness,
        rationale: verdict.rationale,
        title: plan.title,
        complexity: plan.complexity,
        size: plan.size,
        criteria: ids.length,
      };
      if (A.until === 'plan')
        return finish('stopped', {
          plannedWork: plan,
          headline: `Planned #${String(n)}: ${plan.title}.`,
        });

      // ── Implement ─────────────────────────────────────────────────────────────────────────
      ctx.phase('Implement');
      const team: ImplementTeam = ImplementTeam.from({
        mechanic: ctx.roster.Mechanic,
        surgeon: ctx.roster.Surgeon,
      });
      const schema = Implemented([firstId, ...otherIds]);
      const planText = JSON.stringify(plan, null, 1);
      let slot = implementerSlot(plan, A.implementer);
      let round = 0;
      const ask = (
        who: 'mechanic' | 'surgeon',
        retry: boolean,
        followup: Parameters<typeof prompts.Implement>[0]['followup'],
      ) => {
        round++;
        return team[who].value(id('impl', round), {
          ...place,
          prompt: prompts.Implement({
            situation: situation(planFile),
            standingNotes: A.standingNotes,
            plan: planText,
            planFile: planFile ?? '',
            commitTrailer: A.commitTrailer.trim(),
            checkCommand: A.checkCommand,
            retry,
            followup,
          }),
          schema,
        });
      };
      // Don't take the implementer's word: every criterion settled, the reported commits on the
      // branch, commits of its own, a clean tree, and the full suite passing at that exact head.
      const evaluate = async (report: ImplementedResult): Promise<Outcome> => {
        const open = unsettled(ids, report.criteria);
        if (open.length)
          return {
            problems: `unfinished criteria: ${open.map((o) => `${o.id} (${o.status}: ${o.evidence})`).join('; ')}`,
            check: null,
          };
        const verified = await verify(ctx, id('impl', round, 'verify'), {
          workdir: W,
          base: DEF,
          commits: shaCommits(report.criteria),
        });
        if (!verified.ok)
          return { problems: `could not verify: ${verified.error.message}`, check: null };
        const v = verified.value;
        const problem =
          v.branch !== started.branch
            ? `the worktree is on ${v.branch ?? 'a detached HEAD'}, not ${started.branch}`
            : !v.ahead
              ? 'the branch has no commits of its own'
              : v.missingCommits.length
                ? `reported commits not on the branch: ${v.missingCommits.join(', ')}`
                : v.dirty.length
                  ? `worktree not clean: ${v.dirty.slice(0, 5).join(', ')}`
                  : null;
        if (problem !== null) return { problems: problem, check: null };
        const check = await runCheck(ctx, id('impl', round, 'check'), {
          workdir: W,
          branch: started.branch,
          dir,
          label: `impl-${String(round)}`,
          command: A.checkCommand,
        });
        if (!check.passed || check.head !== v.head) {
          const why = check.error ?? (check.failedStep ? `${check.failedStep} failed` : 'failed');
          return {
            problems: `no passing check at ${v.head.slice(0, 7)}: ${why}${check.log ? ` (${check.log})` : ''}`,
            check,
          };
        }
        return { report, head: v.head, ahead: v.ahead };
      };

      let answer = await ask(slot, false, null);
      if (!answer.ok) {
        ctx.log('implementer ended without a result; retrying once');
        answer = await ask(slot, true, null);
      }
      const firstNotes = answer.ok ? answer.value.notes : [];
      let outcome: Outcome = answer.ok
        ? await evaluate(answer.value)
        : { problems: 'the implementer returned nothing', check: null };
      if ('problems' in outcome) {
        if (!answer.ok && slot === 'surgeon') {
          record.implementer = { tier: slot, rounds: round };
          return blocked('implement', 'implementer returned nothing');
        }
        // One follow-up round: the mechanic escalates to the surgeon, or the surgeon gets a
        // finishing round; either way the previous report and the check log go with it.
        const escalated = slot === 'mechanic';
        ctx.log(
          `#${String(n)}: ${outcome.problems}; ${escalated ? 'escalating to the surgeon' : 'one finishing round'}`,
        );
        slot = 'surgeon';
        const previous = answer.ok
          ? JSON.stringify(
              {
                criteria: answer.value.criteria,
                deviations: answer.value.deviations,
                followups: answer.value.followups,
                notes: answer.value.notes,
              },
              null,
              1,
            )
          : null;
        const followed = await ask('surgeon', false, {
          escalated,
          problems: outcome.problems,
          checkLog: outcome.check?.log ?? null,
          excerpt: outcome.check?.excerptFile ?? null,
          previous,
        });
        if (!followed.ok) {
          record.implementer = { tier: slot, rounds: round };
          return blocked(
            'implement',
            `the follow-up round returned nothing; before it: ${outcome.problems}`,
          );
        }
        outcome = await evaluate(followed.value);
      }
      record.implementer = { tier: slot, rounds: round };
      if ('problems' in outcome) {
        // The implementer's own diagnosis: a red suite has been main's fault before (#581).
        const why = firstNotes.slice(0, 2).join(' | ').slice(0, 700);
        return blocked(
          'implement',
          `${outcome.problems}${why ? `; implementer notes: ${why}` : ''}`,
        );
      }
      const done = outcome;
      record.implementer = {
        tier: slot,
        rounds: round,
        head: done.head,
        commits: done.ahead,
        deviations: done.report.deviations,
        notes: done.report.notes,
      };
      record.verifyOnPr = done.report.criteria
        .filter((x) => x.status === 'verify-on-pr')
        .map((x) => ({ id: x.id, check: x.evidence }));
      record.deviations = done.report.criteria
        .filter((x) => x.status === 'deviation')
        .map((x) => ({ id: x.id, reason: x.evidence }));
      ctx.log(`#${String(n)} implemented at ${done.head.slice(0, 7)} (${slot})`);
      if (A.until === 'implement')
        return finish('stopped', {
          headline: `Implemented #${String(n)} on ${started.branch} (${done.head.slice(0, 7)}); not published.`,
        });

      // ── Publish (PR text ∥ follow-ups) ────────────────────────────────────────────────────
      ctx.phase('Publish');
      const writePr = async () => {
        const snapped = await snapshot(ctx, id('snapshot'), { workdir: W, dir, base: DEF });
        if (!snapped.ok) return { error: `snapshot: ${snapped.error.message}` };
        const text = await ctx.roster.Scribe.value(id('pr-text'), {
          ...place,
          prompt: prompts.WritePr({
            situation: situation(planFile),
            plan: JSON.stringify({
              title: plan.title,
              approach: plan.approach,
              risks: plan.risks,
              outOfScope: plan.outOfScope,
            }),
            report: JSON.stringify({
              criteria: done.report.criteria,
              deviations: done.report.deviations,
              notes: done.report.notes,
            }),
            stat: snapped.value.stat,
            commitsFile: snapped.value.files.commits,
            diffFile: snapped.value.files.diff,
            checkCommand: A.checkCommand,
            head: done.head.slice(0, 7),
            footer: A.prFooter.trim(),
            title: JSON.stringify(plan.title),
          }),
          schema: PrText,
        });
        return text.ok ? text.value : { error: 'the PR description writer returned nothing' };
      };
      // Implementers are told that the follow-ups they list are filed for them, so every one must
      // be filed, or matched to an issue that is confirmed open, before the PR opens.
      const fileFollowups = async (): Promise<Filed[]> => {
        const items = done.report.followups.map((f, i) => ({ ...f, key: `f${String(i + 1)}` }));
        const [firstKey, ...otherKeys] = items.map((f) => f.key);
        if (firstKey === undefined) return [];
        const parent = await ensureFollowupEpic();
        const drafted = await ctx.roster.Scribe.value(id('followups', 'draft'), {
          ...place,
          prompt: prompts.WriteFollowups({
            situation: situation(planFile),
            followupEpic: parent,
            followupEpicTitle: A.followupEpicTitle,
            items,
            keys: items.map((f) => f.key),
          }),
          schema: Writeups([firstKey, ...otherKeys]),
        });
        const filed: Filed[] = [];
        for (const item of items) {
          const key = item.key;
          const draft = drafted.ok ? drafted.value.issues.find((w) => w.key === key) : undefined;
          const failed = (error: string): Filed => ({
            key,
            number: null,
            title: null,
            action: 'failed',
            error,
          });
          if (draft === undefined) {
            filed.push(
              failed(drafted.ok ? 'not written up' : 'the follow-up scribe returned nothing'),
            );
            continue;
          }
          if (draft.duplicateOf > 0) {
            // The scribe's match is a claim: it settles the key only if that issue is open.
            const seen = await issueState(ctx, id('followups', key, 'duplicate'), {
              repo,
              number: draft.duplicateOf,
            });
            filed.push(
              seen === null
                ? failed(`claimed duplicate #${String(draft.duplicateOf)} does not exist`)
                : seen.state === 'OPEN'
                  ? {
                      key,
                      number: seen.number,
                      title: seen.title,
                      action: 'duplicate',
                      error: null,
                    }
                  : failed(`claimed duplicate #${String(draft.duplicateOf)} is ${seen.state}`),
            );
            continue;
          }
          const found = await findOpenIssueByTitle(ctx, id('followups', key, 'find'), {
            repo,
            title: draft.title,
          });
          if (found !== null) {
            // A follow-up only has to exist: one under another parent stays where it is.
            const linked = await linkSubIssue(ctx, id('followups', key, 'link'), {
              repo,
              parent,
              number: found.number,
            });
            if (linked.conflict !== null)
              ctx.log(
                `Follow-up #${String(found.number)} stays under ${linked.conflict}, not #${String(parent)}`,
              );
            filed.push({
              key,
              number: found.number,
              title: found.title,
              action: 'existing',
              error: null,
            });
            continue;
          }
          const created = await gh.issue.create(
            id('followups', key, 'file'),
            {
              title: draft.title,
              body: `${draft.body.trimEnd()}${followupFooter(parent, n)}`,
              labels: [draft.label],
              parent,
            },
            write,
          );
          filed.push({
            key,
            number: created.number,
            title: draft.title,
            action: 'created',
            error: null,
          });
        }
        return filed;
      };
      const [prText, filed] = await Promise.all([writePr(), fileFollowups()]);
      record.followups.push(...filed);
      if ('error' in prText) return blocked('publish', prText.error);
      const unfiled = filed.filter((f) => f.number === null);
      if (unfiled.length)
        return blocked(
          'publish',
          `follow-up(s) ${unfiled.map((f) => `${f.key} (${String(f.error)})`).join(', ')} not filed; re-running is safe, since filing matches open issues by title`,
        );
      const section = filed.length
        ? prompts.FollowupsSection({
            epic: record.followupEpic ?? 0,
            items: filed.map((f) => ({ number: f.number ?? 0, title: f.title })),
          }).text
        : '';
      const body = withFollowups(prBody(prText.body, n, E), section, A.prFooter);
      const pushed = await publish(ctx, id('push'), {
        workdir: W,
        branch: started.branch,
        sha: done.head,
        lease: started.remoteSha,
      });
      if (!pushed.ok) return blocked('publish', pushed.error.message);
      // Before the PR opens, so a review that answers it quickly still counts.
      const since = await ctx.now(id('since'));
      const opened = await gh.pr.create(
        id('pr'),
        { head: started.branch, base: DEF, title: prText.title, body },
        write,
      );
      target = { pr: opened.number, url: opened.url, head: done.head, since, inFlight: false };
      break;
    }
    if (target === null)
      return finish('stalled', {
        headline: `No candidate in #${String(E)} was ready this run: ${record.skipped.map((s) => `#${String(s.number)} (blocked by ${refs(s.blockedBy)})`).join('; ')}.`,
      });

    const T = worked;
    record.pr = { number: target.pr, url: target.url, mergeCommit: null };
    ctx.log(
      `PR #${String(target.pr)} ${target.inFlight ? '(already open)' : 'opened'}: ${target.url}`,
    );
    // With merge-down's default local Codex review the landing reviews the head itself; in GitHub
    // mode, wait for Codex's automatic first review so the landing triages it in its first pass.
    // CI is not waited for here: the landing gate does that.
    if (!target.inFlight && target.since !== null && A.mergeDown.codexMode === 'github') {
      const first = await gh.waitReview(ctx.id('publish', 'first-review'), {
        pr: target.pr,
        sha: target.head,
        since: target.since,
        reviewers: [codexReviewer()],
        timeoutMs: 21 * MINUTE,
      });
      if (first.status === 'timeout')
        record.notes.push(
          'the first Codex review did not finish in time; merge-down-pr will request one',
        );
      else ctx.log(`First review: ${first.status}`);
    }
    if (A.until === 'pr')
      return finish('pr-open', {
        headline: target.inFlight
          ? `PR #${String(target.pr)} for #${String(T.number)} "${T.title}" is open.`
          : `Opened PR #${String(target.pr)} for #${String(T.number)} "${T.title}".`,
      });

    // ── Land (merge-down-pr as a typed inline child) ────────────────────────────────────────
    ctx.phase('Land');
    const followupEpic = await ensureFollowupEpic();
    const { root: childRootOverride, ...overrides } = A.mergeDown;
    const childRoot =
      childRootOverride ?? (A.root === undefined ? undefined : join(paths.root, 'merge-down'));
    const landed = await ctx.workflow(
      'land',
      mergeDownPr,
      MergeDownInput.parse({
        ...overrides,
        ...(childRoot === undefined ? {} : { root: childRoot }),
        pr: target.pr,
        repo,
        parentEpic: E,
        followupEpic,
        followupEpicTitle: A.followupEpicTitle,
        checkCommand: overrides.checkCommand ?? A.checkCommand,
        standingNotes: landingNotes({
          standingNotes: A.standingNotes,
          ticket: T.number,
          epic: E,
          planFile,
          verifyOnPr: record.verifyOnPr ?? [],
          deviations: record.deviations ?? [],
        }),
      }),
    );
    record.landing = {
      status: landed.status,
      mergeCommit: landed.mergeCommit,
      threads: landed.threads.length,
      fixes: landed.fixes?.length ?? 0,
      followups: landed.followups,
      summaryCommentUrl: landed.summaryCommentUrl,
      headline: landed.headline,
      blocked: landed.blocked,
    };
    if (landed.followupEpic !== null) record.followupEpic = landed.followupEpic;
    if (landed.status !== 'merged')
      return blocked(
        'land',
        `merge-down-pr ended ${landed.status}${landed.blocked ? ` at ${landed.blocked.stage}: ${landed.blocked.reason}` : ''}; PR #${String(target.pr)} stays open and the next run resumes it`,
      );
    record.pr.mergeCommit = landed.mergeCommit;

    // ── Report ──────────────────────────────────────────────────────────────────────────────
    ctx.phase('Report');
    await tick(ctx, ctx.id('report', 'tick'), { repo, epic: E, ticket: T.number });
    const at = new Date(await ctx.now(ctx.id('report', 'at'))).toISOString();
    await appendLedger(ctx, ctx.id('report', 'ledger'), {
      file: join(paths.epicDir, 'ledger.jsonl'),
      line: ledgerLine({
        ticket: T.number,
        title: T.title,
        pr: target.pr,
        mergeCommit: landed.mergeCommit,
        implementer: record.implementer?.tier ?? null,
        landing: { threads: record.landing.threads, fixes: record.landing.fixes },
        followups: [
          ...record.followups.map((f) => f.number),
          ...landed.followups.map((f) => f.number),
        ].filter((x): x is number => x !== null),
        at,
      }),
    });
    const after = await survey('report', 'survey');
    record.remaining = counts(after.snap.items, after.selection);
    const next = after.selection.pick;
    record.next = next ? { number: next.number, title: next.title, status: next.status } : null;
    return finish('landed', {
      headline:
        `#${String(T.number)} "${T.title}" landed as PR #${String(target.pr)} (${String(landed.mergeCommit).slice(0, 7)}). ${plain(landed.headline ?? '')}`.trim(),
    });
  },
});
