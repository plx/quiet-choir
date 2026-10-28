// codebase-atlas: control flow only. Git pins the commit and its tracked files, a survey is matched
// against them and capped core first, readers fill one card each in a settled map, code assembles
// the atlas around a synthesized overview, and one critique groups its gaps into a capped, settled
// repair round whose cards code merges before the guarded write.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import {
  Card,
  CodebaseAtlasInput,
  CodebaseAtlasOutput,
  Critique,
  Survey,
  Synthesis,
} from '../contracts.js';
import { render } from '../lib/atlas.js';
import { isDirty, pinCommit, trackedFiles } from '../lib/git.js';
import {
  applyRepairs,
  atlasStatus,
  cap,
  groupGaps,
  keyFilesOf,
  layout,
  resolveSurvey,
  same,
  sectionsOf,
  uncovered,
} from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

const LISTED_FILES = 100;

export default defineWorkflow({
  name: 'codebase-atlas',
  version: 'packaged-03',
  description:
    'Survey a pinned commit into subsystems, deep-read them into cards, assemble the atlas in code and repair the gaps one critique finds.',
  roster,
  prompts: [prompts],
  input: CodebaseAtlasInput,
  output: CodebaseAtlasOutput,
  async run(ctx, input) {
    const commit = await pinCommit(ctx);
    const dirty = await isDirty(ctx);
    const empty = {
      commit,
      dirty,
      atlasPath: null,
      written: null,
      atlas: null,
      projectSummary: null,
      subsystems: [],
      skipped: [],
      unmatched: [],
      unread: [],
      uncovered: [],
      droppedPaths: [],
      repairs: [],
      unrepaired: [],
    };
    // An existing atlas is replaced only on request, and then only if it is unchanged at the write.
    const existing = await ctx.readFile('existing', input.out, { onError: 'return' });
    if (existing.ok && !input.replace)
      return { ...empty, status: 'refused', critique: 'Not run: out exists and replace is off.' };
    const baseline = existing.ok ? existing.value.sha256 : null;
    const tracked = await trackedFiles(ctx, commit);
    const isTracked = new Set(tracked);
    const survey = await ctx.roster.Surveyor.value('survey', {
      schema: Survey,
      prompt: prompts.Survey({ ...layout(tracked), maxSubsystems: input.maxSubsystems }),
    });
    const { projectSummary } = survey;
    const { matched, unmatched } = resolveSurvey(survey.subsystems, tracked);
    const { chosen, skipped } = cap(matched, input.maxSubsystems);
    const report = {
      ...empty,
      projectSummary,
      skipped: skipped.map((subsystem) => subsystem.name),
      unmatched,
      uncovered: uncovered(matched, tracked),
    };
    if (!chosen.length)
      return { ...report, status: 'empty', critique: 'Not run: no subsystem matched a file.' };
    const names = chosen.map((subsystem) => subsystem.name);
    const read = await ctx.map(
      'read',
      chosen,
      { concurrency: 4, onError: 'return' },
      ({ name, paths, hint, files }) =>
        ctx.roster.Reader.value('card', {
          schema: Card,
          prompt: prompts.Read({
            name,
            paths: [...paths],
            hint,
            files: files.slice(0, LISTED_FILES),
            moreFiles: Math.max(0, files.length - LISTED_FILES),
            projectSummary,
            others: names.filter((other) => other !== name),
          }),
        }),
    );
    const first = sectionsOf(chosen, read, isTracked);
    const missing = { ...report, unread: first.unread, droppedPaths: first.dropped };
    if (!first.sections.length)
      return { ...missing, status: 'degraded', critique: 'Not run: every deep reader failed.' };
    const synthesis = await ctx.roster.Synthesizer.value('synthesize', {
      schema: Synthesis(keyFilesOf(first.sections)),
      prompt: prompts.Synthesize({
        projectSummary,
        cards: std.exec.json(first.sections),
        unread: first.unread,
        skipped: report.skipped,
      }),
    });
    const document = { commit, dirty, synthesis, skipped: report.skipped, unread: first.unread };
    const draft = render({ ...document, sections: first.sections, unmatched });
    const critique = await ctx.roster.Critic.value('critique', {
      schema: Critique,
      onError: 'return',
      prompt: prompts.Critique({
        commit,
        atlas: draft,
        sections: first.sections.map((section) => section.name),
        skipped: report.skipped,
        unread: first.unread,
        unmatched,
        uncovered: report.uncovered,
      }),
    });
    const groups = critique.ok ? groupGaps(critique.value.gaps) : [];
    const repairing = groups.slice(0, input.maxRepairs);
    const results = repairing.length
      ? await ctx.map(
          'repairs',
          repairing,
          { concurrency: 3, onError: 'return' },
          ({ section, gaps }) => {
            const current = first.sections.find((entry) => same(entry.name, section));
            return ctx.roster.Reader.value('repair', {
              schema: Card,
              prompt: prompts.Repair({
                section,
                gaps: gaps.map(({ description, repairAction }) => ({ description, repairAction })),
                card: current ? std.exec.json(current.card) : null,
                projectSummary,
                others: first.sections
                  .map((entry) => entry.name)
                  .filter((name) => !same(name, section)),
              }),
            });
          },
        )
      : [];
    const merged = applyRepairs(first.sections, repairing, results, matched, isTracked);
    const atlas = render({ ...document, sections: merged.sections, unmatched });
    const write = await ctx.writeFile('write', input.out, atlas, {
      ifMatch: baseline,
      onError: 'return',
    });
    const droppedPaths = [...first.dropped, ...merged.dropped];
    const unrepaired = groups
      .slice(input.maxRepairs)
      .map(({ section, gaps }) => ({ section, gaps: gaps.length }));
    const status = atlasStatus({
      unread: first.unread.length,
      unmatched: unmatched.length,
      dropped: droppedPaths.length,
      criticFailed: !critique.ok,
      failedRepairs: merged.repairs.filter((repair) => repair.outcome === 'failed').length,
      skipped: skipped.length,
      unrepaired: unrepaired.length,
      gaps: groups.length,
    });
    return {
      ...missing,
      status: write.ok ? status : 'refused',
      atlasPath: write.ok ? input.out : null,
      written: write.ok ? write.value : null,
      atlas,
      subsystems: merged.sections.map(({ name, importance, origin, card }) => ({
        name,
        importance,
        purpose: card.purpose,
        origin,
      })),
      droppedPaths,
      critique: critique.ok ? critique.value.verdict : 'critic unavailable',
      repairs: merged.repairs,
      unrepaired,
    };
  },
});
