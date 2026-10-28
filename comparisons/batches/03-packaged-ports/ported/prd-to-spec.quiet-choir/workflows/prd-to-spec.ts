// prd-to-spec: control flow only. Code reads the PRD, refuses an existing out and lists the
// codebase; one grounder maps it unless greenfield; five lenses draft as a settled map; code merges
// and ranks the contested decisions and, when asked, settles a load-bearing top decision with the
// design-tournament package's workflow as a settled inline child. One merger writes the spec, whose
// headings and decision IDs code checks; two audits run as a settled map, one repair follows any
// gap, and code reads back the open questions and writes the document.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import designTournament from '../../design-tournament.quiet-choir/workflows/design-tournament.js';
import {
  Audit,
  AuditReply,
  Ground,
  Lens,
  LensDraft,
  PrdToSpecInput,
  PrdToSpecOutput,
  SpecDocument,
} from '../contracts.js';
import {
  auditRecords,
  collect,
  delegation,
  status,
  tournamentDecision,
  tournamentOf,
} from '../lib/policy.js';
import { listCodebase, missingFile, readPrd } from '../lib/sources.js';
import { HEADINGS, openQuestions } from '../lib/spec.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

// A schema-invalid or transient failure gets one more attempt before it counts as failed.
const retry = { maxAttempts: 2, on: ['schema', 'transient'] } as const;

export default defineWorkflow({
  name: 'prd-to-spec',
  version: 'packaged-03',
  description:
    'Ground a PRD in the codebase, draft five technical lenses, optionally settle the top load-bearing decision with a design-tournament child, merge, audit twice and repair once.',
  roster,
  prompts: [prompts],
  children: [designTournament],
  input: PrdToSpecInput,
  output: PrdToSpecOutput,
  async run(ctx, input) {
    const prd = await readPrd(ctx, input.prd, input.maxPrdBytes);
    const report = {
      prd: prd.source,
      codebase: null,
      grounding: null,
      failedLenses: [],
      sections: 0,
      decisions: [],
      tournament: null,
      spec: null,
      verification: { audits: [], repair: 'not-needed' as const },
      openQuestions: [],
      written: null,
    };
    // Both publications create out exclusively, so an existing one is refused before it is paid for.
    if (input.out !== null) {
      const existing = await ctx.readFile('existing', input.out, { onError: 'return' });
      if (!missingFile(existing)) return { ...report, status: 'refused' };
    }
    const codebase =
      input.codebase === 'greenfield'
        ? null
        : await listCodebase(ctx, input.codebase, input.maxCodebaseFiles);
    // The spec must fit the code that exists; a failed map fails the run rather than pass as greenfield.
    const grounding = codebase
      ? await ctx.roster.Grounder.value('ground', {
          schema: Ground,
          prompt: prompts.Ground({ prd: prd.text, codebase }),
          retry,
        })
      : null;
    // `version` names the prompt and schema, which a settled map's fingerprint does not show.
    const drafts = await ctx.map(
      'lenses',
      Lens.options,
      { concurrency: Lens.options.length, onError: 'return', version: 'lens/1', key: (l) => l },
      (lens) =>
        ctx.roster.LensWriter.value('draft', {
          schema: LensDraft,
          prompt: prompts.Lens({ lens, prd: prd.text, grounding }),
          retry,
        }),
    );
    const { sections, decisions, failedLenses } = collect(Lens.options, drafts);
    const drafted = {
      ...report,
      codebase: codebase && {
        path: codebase.path,
        files: codebase.files.length + codebase.omitted,
        listed: codebase.files.length,
      },
      grounding,
      failedLenses,
      sections: sections.length,
    };
    if (!sections.length)
      return {
        ...drafted,
        decisions: decisions.map((d) => ({ ...d, settledBy: null })),
        status: 'undrafted',
      };
    // Reversible choices do not earn a tournament: only a load-bearing top decision, when asked.
    const top = tournamentDecision(decisions, input.decideArchitecture);
    const settled = top
      ? tournamentOf(
          top,
          await ctx.workflow(
            'tournament',
            designTournament,
            designTournament.input.parse({
              brief: prompts.Brief({ decision: top }).text,
              context: prompts.Context({ prd: prd.text, grounding }).text,
              judges: input.judges,
              crossHarness: input.crossHarness,
            }),
            { profiles: delegation, onError: 'return' },
          ),
        )
      : null;
    const adopted = top && settled?.design ? { id: top.id, design: settled.design } : null;
    const ids = decisions.map((decision) => decision.id);
    const structure = { headings: [...HEADINGS], ids };
    const merged = await ctx.roster.Merger.value('merge', {
      schema: SpecDocument(ids),
      prompt: prompts.Merge({
        prd: prd.text,
        grounding,
        ...structure,
        sections,
        decisions,
        settled: adopted,
      }),
      retry,
    });
    const replies = await ctx.map(
      'audits',
      Audit.options,
      { concurrency: 2, onError: 'return', version: 'audit/1', key: (a) => a },
      (audit) =>
        ctx.roster.Auditor.value('audit', {
          schema: AuditReply,
          prompt: prompts.Audit({
            audit,
            spec: merged.spec,
            prd: audit === 'fidelity' ? prd.text : null,
          }),
          retry,
        }),
    );
    const audits = auditRecords(Audit.options, replies);
    const gaps = audits.flatMap(({ audit, gaps }) => gaps.map((gap) => ({ ...gap, audit })));
    // One repair round, as upstream; a failed repair keeps the merged spec and degrades the status.
    const repaired = gaps.length
      ? await ctx.roster.Repairer.value('repair', {
          schema: SpecDocument(ids),
          prompt: prompts.Repair({
            prd: prd.text,
            spec: merged.spec,
            ...structure,
            gaps,
            settled: adopted?.id ?? null,
          }),
          retry,
          onError: 'return',
        })
      : null;
    const spec = repaired?.ok ? repaired.value.spec : merged.spec;
    const repair = repaired === null ? 'not-needed' : repaired.ok ? 'applied' : 'failed';
    // Exclusive creation still refuses a document that appeared after the check above.
    const written =
      input.out === null
        ? null
        : input.publication === 'commit'
          ? await std.exec.committedArtifact(ctx, input.out, `${spec}\n`)
          : await ctx.writeFile('write', input.out, `${spec}\n`, { ifMatch: null });
    const tournament = settled?.record ?? null;
    return {
      ...drafted,
      decisions: decisions.map((d) => ({
        ...d,
        settledBy: adopted?.id === d.id ? ('tournament' as const) : ('merger' as const),
      })),
      tournament,
      spec,
      verification: { audits, repair },
      openQuestions: openQuestions(spec),
      written,
      status: status({ failedLenses, audits, tournament, repair }),
    };
  },
});
