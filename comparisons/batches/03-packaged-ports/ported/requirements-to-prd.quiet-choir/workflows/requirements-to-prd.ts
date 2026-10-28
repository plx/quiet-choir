// requirements-to-prd: control flow only. Code refuses an existing out it may not replace before
// any agent runs, then reads the material; four lenses extract findings as a settled map and code
// checks each quote against the material. One writer drafts the PRD's sections, three settled
// critics attack it, and the writer revises it once. Each question round asks the open questions
// durably and redoes the PRD with the answers; code renders the document and writes it.
import { defineWorkflow } from 'quiet-choir';
import {
  Answers,
  Charter,
  Critique,
  Extraction,
  Lens,
  PrdReply,
  RequirementsInput,
  RequirementsOutput,
  extractCaps,
  maxIssues,
} from '../contracts.js';
import { readMaterial } from '../lib/material.js';
import { checkOut, publish } from '../lib/out.js';
import {
  collect,
  complete,
  issuesOf,
  refused,
  status,
  summary,
  type Round,
} from '../lib/policy.js';
import { questionDetails, render } from '../lib/render.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'requirements-to-prd',
  version: 'packaged-03',
  description:
    'Extract quoted findings through four lenses, draft a traced PRD, attack it with three critics, revise once, and surface unknowns as open questions.',
  roster,
  prompts: [prompts],
  input: RequirementsInput,
  output: RequirementsOutput,
  async run(ctx, input) {
    const target =
      input.out === null ? null : await checkOut(ctx, input.out, input.replace, input.publication);
    if (target && 'refusal' in target) return refused(target.refusal);
    const documents = await readMaterial(ctx, input.input, input.maxMaterialBytes);
    const { product } = input;
    const lenses = Lens.options;
    const charters = Charter.options;
    // One drafting round: the step IDs are relative, so a later round runs under its own scope.
    const draftRound = async (answers: string[]): Promise<Round> => {
      // `version` names the prompt and schema, which a settled map's fingerprint does not show.
      const readings = documents.some((document) => document.text.trim())
        ? await ctx.map(
            'extract',
            lenses,
            { concurrency: lenses.length, onError: 'return', version: 'extract/2' },
            (lens) =>
              ctx.roster.Extractor.value('read', {
                schema: Extraction,
                prompt: prompts.Extract({ lens, product, answers, documents, caps: extractCaps }),
                retry: { maxAttempts: 2, on: ['schema'] },
              }),
          )
        : [];
      const sources = [
        ...documents,
        ...answers.map((answer) => ({ label: 'answers', text: answer })),
      ];
      const pooled = collect(sources, lenses, readings);
      const { findings } = pooled;
      const report: Round = {
        ...pooled,
        failedLenses: lenses.filter((_, index) => readings[index]?.ok === false),
        critics: charters.length,
        failedCritics: [],
        issues: [],
        revised: false,
        prd: null,
        added: [],
      };
      const [first, ...rest] = findings;
      if (!first) return report;
      const schema = PrdReply([first.id, ...rest.map((finding) => finding.id)]);
      const draft = complete(
        await ctx.roster.Writer.value('draft', {
          schema,
          prompt: prompts.Draft({ product, ...pooled }),
          retry: { maxAttempts: 2, on: ['schema'] },
        }),
        findings,
      );
      const text = render(draft.prd, findings);
      const critiques = await ctx.map(
        'attack',
        charters,
        { concurrency: charters.length, onError: 'return', version: 'attack/2' },
        (critic) =>
          ctx.roster.Critic.value('critique', {
            schema: Critique,
            prompt: prompts.Attack({ critic, product, prd: text, maxIssues }),
            retry: { maxAttempts: 2, on: ['schema'] },
          }),
      );
      const failedCritics = charters.filter((_, index) => critiques[index]?.ok === false);
      const issues = issuesOf(charters, critiques);
      const drafted = { ...report, failedCritics, issues, prd: draft.prd, added: draft.added };
      if (!issues.length) return drafted;
      // A failed revision keeps the draft, as upstream; the status says it was not revised.
      const revision = await ctx.roster.Writer.value('revise', {
        schema,
        prompt: prompts.Revise({ prd: text, issues }),
        retry: { maxAttempts: 2, on: ['schema'] },
        onError: 'return',
      });
      if (!revision.ok) return drafted;
      const revised = complete(revision.value, findings);
      return { ...drafted, revised: true, prd: revised.prd, added: revised.added };
    };

    const answers = input.answers === null ? [] : [input.answers];
    let round = await draftRound([...answers]);
    const asked: RequirementsOutput['asked'] = [];
    for (let n = 1; n <= input.questionRounds; n++) {
      const open = round.prd?.openQuestions ?? [];
      if (!open.length) break;
      const reply = await ctx.ask(ctx.id('questions', n), {
        title: 'Questions',
        prompt:
          'Answer the PRD open questions in one text to redo the PRD with them, or answer empty text to keep them open.',
        schema: Answers,
        details: questionDetails(open),
        subject: { round: n, questions: open },
        audience: 'human',
        choices: [{ value: { answers: '' }, label: 'Keep them open' }],
      });
      const answered = reply.answers.trim().length > 0;
      const { failedLenses, failedCritics } = round;
      asked.push({
        round: n,
        questions: open.length,
        answered,
        status: status(round),
        failedLenses,
        failedCritics,
      });
      if (!answered) break;
      answers.push(reply.answers);
      round = await ctx.scope(ctx.id('round', n), () => draftRound([...answers]));
    }

    const verdict = status(round);
    const openQuestions = round.prd
      ? round.prd.openQuestions
      : round.unknowns.map((question) => ({ question, consequences: null }));
    const critiqueSummary = summary(round, openQuestions.length, target !== null);
    const sources = documents.map((document) => document.source.path ?? 'inline material');
    const prd =
      round.prd &&
      render(
        round.prd,
        round.findings,
        `Drafted from ${sources.join(', ')} by requirements-to-prd; status: ${verdict}. ${critiqueSummary}`,
      );
    const output = {
      status: verdict,
      material: documents.map((document) => document.source),
      rounds: 1 + asked.filter((entry) => entry.answered).length,
      answers,
      asked,
      failedLenses: round.failedLenses,
      findings: round.findings,
      unknowns: round.unknowns,
      conflicts: round.conflicts,
      failedCritics: round.failedCritics,
      issues: round.issues,
      revised: round.revised,
      prd,
      assumptions: round.prd?.assumptions.map((assumption) => assumption.text) ?? [],
      addedAssumptions: round.added,
      openQuestions,
      critiqueSummary,
      written: null,
    };
    if (input.out === null || target === null || prd === null) return output;
    // Against the baseline checked before the run: a file that appeared or changed since fails.
    const written = await publish(ctx, input.out, prd, input.publication, target.ifMatch);
    return { ...output, written };
  },
});
