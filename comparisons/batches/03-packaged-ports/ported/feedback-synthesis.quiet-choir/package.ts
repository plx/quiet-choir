// Packaged rewrite of the pinned MIT upstream feedback-synthesis.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import feedbackSynthesis from './workflows/feedback-synthesis.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'feedback-synthesis',
  version: '1',
  description:
    'Parse a feedback corpus into numbered items in code, fix a theme vocabulary on an even sample, tag disjoint shards in parallel, count, check quotes and rank by severity in code, and deep-dive the top themes into a quotable report',
  whenToUse:
    'Turning support, review, NPS or survey exports in the repository into ranked product themes with counts, severity and verbatim quotes; read-only, and every item is accounted for. Input: {sources, format?, textField?, fields?, focus?, deepDives?, severityWeight?, sampleSize?, shardSize?, maxShards?, diveItems?}.',
  workflows: [feedbackSynthesis],
  entry: feedbackSynthesis,
  prompts: [prompts],
});
