// lifecycle-document: draft and gate one lifecycle document, then commit it through a managed
// checkout so later implementation integrates without an untracked-document dirty tree.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { DocumentInput, DocumentReview, StageResult } from '../contracts.js';
import { prompts } from '../prompts.js';
import { documentRoster } from '../roster.js';

export default defineWorkflow({
  name: 'lifecycle-document',
  version: 'packaged-03',
  description: 'Draft, gate and commit one lifecycle document.',
  roster: documentRoster,
  prompts: [prompts],
  input: DocumentInput,
  output: StageResult,
  async run(ctx, { out, ...context }) {
    const content = await ctx.roster.Author.value('draft', { prompt: prompts.Draft(context) });
    const review = await ctx.roster.Reviewer.value('review', {
      schema: DocumentReview,
      prompt: prompts.Review({ ...context, content }),
    });
    // A redo writes a new path, so the exclusive create never meets its own earlier artifact.
    await std.exec.committedArtifact(ctx, out, `${content}\n`);
    return { ...review, artifact: out };
  },
});
