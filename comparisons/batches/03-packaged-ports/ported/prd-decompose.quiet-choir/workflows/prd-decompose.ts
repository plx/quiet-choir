// prd-decompose: control flow only. Code reads the PRD and lists the codebase; five lenses read it
// as a settled map and code keeps only the items whose quote it finds in the PRD. One merger builds
// the ordered backlog and code carries the items' anchors onto it. A backwards coverage critic and
// a patch-only repairer then alternate up to maxRepairs times; code applies each anchored patch,
// schedules the tickets and writes the document.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Coverage,
  Lens,
  LensReading,
  MergeReply,
  PrdDecomposeInput,
  PrdDecomposeOutput,
  Repair,
  type Ticket,
} from '../contracts.js';
import {
  anchorTickets,
  applyRepair,
  collect,
  schedule,
  status,
  unmerged,
  type CoverageRecord,
} from '../lib/policy.js';
import { render } from '../lib/render.js';
import { listCodebase, readPrd } from '../lib/sources.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

const ids = (tickets: readonly { id: string }[]) =>
  tickets.map((ticket) => ticket.id) as [string, ...string[]];

export default defineWorkflow({
  name: 'prd-decompose',
  version: 'packaged-03',
  description:
    'Read a PRD through five settled lenses, merge anchored items into ordered tickets, and audit coverage backwards with patch repairs.',
  roster,
  prompts: [prompts],
  input: PrdDecomposeInput,
  output: PrdDecomposeOutput,
  async run(ctx, input) {
    const prd = await readPrd(ctx, input.prd, input.maxPrdBytes);
    const codebase =
      input.codebase === null
        ? null
        : await listCodebase(ctx, input.codebase, input.maxCodebaseFiles);
    const report = {
      prd: prd.source,
      codebase: codebase && {
        path: codebase.path,
        files: codebase.files.length + codebase.omitted,
        listed: codebase.files.length,
      },
      written: null,
    };
    const lenses = Lens.options;
    // The root of a repository with nothing tracked yet lists no file worth showing.
    const listing = codebase?.files.length ? codebase : null;
    // `version` names the prompt and schema, which a settled map's fingerprint does not show.
    const readings = prd.text.trim()
      ? await ctx.map(
          'lenses',
          lenses,
          { concurrency: lenses.length, onError: 'return', version: 'lens/1' },
          (lens) =>
            ctx.roster.LensReader.value('read', {
              schema: LensReading,
              prompt: prompts.Lens({ lens, prd: prd.text, codebase: listing }),
            }),
        )
      : [];
    const failedLenses = lenses.filter((_, index) => readings[index]?.ok === false);
    const { items, unanchored, questions } = collect(prd.text, lenses, readings);
    const empty = {
      ...report,
      failedLenses,
      unanchored,
      tickets: [],
      sequencing: null,
      waves: [],
      criticalPath: null,
      coverage: null,
      openQuestions: questions,
      unmerged: [],
    };
    const [first, ...rest] = items;
    // Nothing to merge or write; the status says whether every lens read the PRD.
    if (!first) return { ...empty, status: status(failedLenses, lenses.length, null) };
    // Ticket identity needs reading, so the merge is an agent's; schemas keep it ordered.
    const merged = await ctx.roster.Merger.value('merge', {
      schema: MergeReply([first.id, ...rest.map((item) => item.id)]),
      prompt: prompts.Merge({ items, questions }),
      retry: { maxAttempts: 2, on: ['schema'] },
    });
    let tickets: Ticket[] = anchorTickets(merged.tickets, items);
    let sequencing = merged.sequencing;
    const coverage: CoverageRecord = {
      audits: 0,
      repairs: 0,
      covered: false,
      gaps: [],
      repaired: [],
      failure: null,
    };
    // Each repair is audited again, so `covered` is a verdict on the final backlog.
    for (let round = 0; ; round++) {
      const audit = await ctx.roster.Critic.value(ctx.id('audit', round), {
        schema: Coverage(ids(tickets)),
        prompt: prompts.Audit({ prd: prd.text, tickets }),
        onError: 'return',
      });
      if (!audit.ok) {
        coverage.failure = { stage: 'audit', message: audit.error.message };
        break;
      }
      coverage.audits += 1;
      coverage.gaps = audit.value.gaps;
      coverage.covered = !coverage.gaps.length;
      if (coverage.covered || round >= input.maxRepairs) break;
      const patch = await ctx.roster.Repairer.value(ctx.id('repair', round), {
        schema: Repair(ids(tickets), prd.text),
        prompt: prompts.Repair({
          prd: prd.text,
          tickets,
          sequencing,
          gaps: coverage.gaps,
          next: `T${String(tickets.length + 1)}`,
        }),
        retry: { maxAttempts: 2, on: ['schema'] },
        onError: 'return',
      });
      if (!patch.ok) {
        coverage.failure = { stage: 'repair', message: patch.error.message };
        break;
      }
      tickets = applyRepair(tickets, patch.value);
      sequencing = patch.value.sequencing ?? sequencing;
      coverage.repairs += 1;
      coverage.repaired.push(...coverage.gaps);
      coverage.gaps = [];
    }
    const backlog = {
      ...empty,
      status: status(failedLenses, lenses.length, coverage),
      tickets,
      sequencing,
      ...schedule(tickets),
      coverage,
      openQuestions: merged.openQuestions,
      unmerged: unmerged(items, tickets),
    };
    if (input.out === null) return backlog;
    // Exclusive creation keeps an existing backlog from being silently overwritten.
    const written =
      input.publication === 'commit'
        ? await std.exec.committedArtifact(ctx, input.out, render(backlog))
        : await ctx.writeFile('write', input.out, render(backlog), { ifMatch: null });
    return { ...backlog, written };
  },
});
