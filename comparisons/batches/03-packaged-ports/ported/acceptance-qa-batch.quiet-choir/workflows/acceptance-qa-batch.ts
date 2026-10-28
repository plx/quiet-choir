// acceptance-qa-batch: control flow only. Code refuses a dirty checkout and pins HEAD; a copyist
// transcribes the backlog and code admits only verbatim criteria. Per ticket a demonstrator writes
// one probe per criterion, and a breaker writes attack probes for the tickets that earned it. A
// human approves each probe list, code runs every probe alone in a pinned checkout, and the exit
// codes, not the agents, decide each ticket's verdict.
import { defineWorkflow } from 'quiet-choir';
import {
  AcceptanceInput,
  AcceptanceOutput,
  AttacksFor,
  Backlog,
  PlanFor,
  type Ticket,
} from '../contracts.js';
import { baseCommit, dirtyPaths, readBacklog, runProbe } from '../lib/checkout.js';
import {
  assess,
  attackProbes,
  attackResults,
  breakerStatus,
  criterionProbes,
} from '../lib/evidence.js';
import { admit, approvalOf, attackable, counts, grade, runStatus } from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'acceptance-qa-batch',
  version: 'packaged-03',
  description:
    'Demonstrate each ticket with approved probes that code runs, attack the ones that pass, and grade both by exit code.',
  roster,
  prompts: [prompts],
  input: AcceptanceInput,
  output: AcceptanceOutput,
  async run(ctx, input) {
    const report = {
      dirty: [],
      base: null,
      runContext: null,
      tickets: [],
      ...counts([]),
      deferred: [],
      skipped: [],
      rejected: [],
      probeDigest: null,
      attackDigest: null,
    };
    const backlog = await readBacklog(ctx, input.tickets);
    const dirty = await dirtyPaths(ctx, backlog.path);
    if (dirty.length) return { ...report, status: 'refused', dirty };
    const base = await baseCommit(ctx);
    // Every agent reads the commit the probes run against, never the live checkout.
    const pinned = { base: { commit: base } };
    const { scope, probeCommand: argv } = input;
    const { tickets, skipped, runContext } = await ctx.roster.Ingester.value('ingest', {
      worktree: pinned,
      schema: Backlog,
      prompt: prompts.Ingest({ backlog: backlog.content, scope, argv }),
    });
    const { admitted, rejected } = admit(tickets, backlog.content);
    const chosen = admitted.slice(0, input.maxTickets);
    const deferred = admitted.slice(input.maxTickets).map(({ id, title }) => ({ id, title }));
    const head = { ...report, base, runContext, skipped, rejected, deferred };
    if (!chosen.length) return { ...head, status: rejected.length ? 'degraded' : 'empty' };
    const brief = { scope, runContext, argv, base };
    const key = (ticket: Ticket) => ctx.id(ticket.id);
    const run = (probe: string) =>
      runProbe(ctx, { base, argv, probe, timeoutMs: input.probeTimeoutMs });

    // A demonstrator that fails leaves its ticket unverified rather than failing the batch.
    const plans = await ctx.map(
      'demonstrate',
      chosen,
      { concurrency: 4, onError: 'return', key },
      (ticket) =>
        ctx.roster.Demonstrator.value('plan', {
          worktree: pinned,
          schema: PlanFor(ticket.acceptanceCriteria.length),
          prompt: prompts.Demonstrate({ ...brief, ticket }),
        }),
    );
    const probes = criterionProbes(chosen, plans);
    const probeList = approvalOf(probes);
    const probesApproved =
      probes.length > 0 &&
      (
        await ctx.approve('approve-probes', {
          title: 'Probes',
          prompt:
            'Run these agent-written probes with the probe command, each in a pinned checkout?',
          subject: { base, argv, digest: probeList.digest, probes },
          details: probeList.preview,
        })
      ).approved;
    const probeRuns = probesApproved
      ? await ctx.map(
          'criteria',
          probes,
          { concurrency: 4, key: (item) => ctx.id(item.ticket, item.criterion) },
          (item) => run(item.probe),
        )
      : [];
    const assessed = assess(chosen, plans, probes, probeRuns);

    // Upstream attacks only the tickets that earned defending; a failed breaker leaves it pending.
    // Each item carries its criteria: a settled map hands the mapper a JSON copy of the item.
    const targets = assessed.filter((assessment) => attackable(assessment.criteria));
    const proposals = await ctx.map(
      'break',
      targets,
      { concurrency: 4, onError: 'return', key: (target) => key(target.ticket) },
      ({ ticket, criteria }) =>
        ctx.roster.Breaker.value('attacks', {
          worktree: pinned,
          schema: AttacksFor(input.maxAttacks),
          prompt: prompts.Break({ ...brief, ticket, criteria, maxAttacks: input.maxAttacks }),
        }),
    );
    const attacks = attackProbes(targets, proposals);
    const attackList = approvalOf(attacks);
    const attacksApproved =
      attacks.length > 0 &&
      (
        await ctx.approve('approve-attacks', {
          title: 'Attacks',
          prompt: 'Run these agent-written attack probes, each in a pinned checkout?',
          subject: { base, argv, digest: attackList.digest, attacks },
          details: attackList.preview,
        })
      ).approved;
    const attackRuns = attacksApproved
      ? await ctx.map(
          'attacks',
          attacks,
          { concurrency: 4, key: (item) => ctx.id(item.ticket, item.attack) },
          (item) => run(item.probe),
        )
      : [];

    const graded = assessed.map((assessment) => {
      const tried = attackResults(assessment.ticket, attacks, attackRuns);
      return grade(assessment, tried, breakerStatus(proposals[targets.indexOf(assessment)], tried));
    });
    const declined =
      (probes.length > 0 && !probesApproved) || (attacks.length > 0 && !attacksApproved);
    return {
      ...head,
      status: runStatus(declined, graded, rejected, deferred),
      tickets: graded,
      ...counts(graded),
      probeDigest: probes.length ? probeList.digest : null,
      attackDigest: attacks.length ? attackList.digest : null,
    };
  },
});
