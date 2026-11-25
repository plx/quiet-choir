/**
 * Investigation patterns, re-exported from `std.patterns`:
 *
 * - {@link falsify} has a theorist propose competing hypotheses for a question, has a falsifier try
 *   to falsify each one separately, and rates the confidence in what survives in code, from the
 *   verdicts: one survivor whose rivals were all falsified is `high`, never a model's own claim.
 * - {@link research} has one scout per source angle propose leads, reads the most promising
 *   distinct leads for cited claims, and has a synthesizer answer the question from those claims
 *   alone, citing them by number.
 *
 * Both take a required `id` and record every step under it; each pattern's TSDoc lists the exact
 * step IDs. Every fan-out is a settled map, so a failed falsifier, scout or reader is journaled,
 * counted and logged, and a resume decides the same way instead of retrying it. Nothing is dropped
 * silently: leads beyond the `reads` cap are logged with `ctx.log` and returned as `deferred`, and
 * hypotheses beyond `count` are logged. The default prompts are `std.text.brief`s; the
 * falsifier's names `untestable` as the safe default when the evidence does not settle a
 * hypothesis.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const log = await std.exec.git(ctx, 'log', ['log', '--stat', '--format=%h %s', 'v1.4.0..v1.4.1']);
 * const incident = await std.patterns.falsify(ctx, {
 *   id: 'incident',
 *   team: { theorist: ctx.roster.Reviewer, falsifier: ctx.roster.Skeptic },
 *   question: 'Why did checkout requests time out after the 1.4.1 deploy?',
 *   evidence: std.text.section('Git log', log),
 * });
 * const answer = await std.patterns.research(ctx, {
 *   id: 'research',
 *   team: {
 *     scout: ctx.roster.Researcher,
 *     reader: ctx.roster.Researcher,
 *     synthesizer: ctx.roster.Writer,
 *   },
 *   question: 'Does undici 7 still pool connections per origin?',
 * });
 * ```
 *
 * @module
 */
import {
  defineTeam,
  type JsonValue,
  type MapStepError,
  type Prompt,
  type Settled,
  type TeamOf,
  type WorkflowContext,
} from '../index.js';
import { corroborate, dedupeBy, normalizeTitle } from './data.js';
import { research as researchAngles, type Lens } from './lenses.js';
import {
  keyed,
  nonEmpty,
  placement,
  positiveInt,
  settledMap,
  statusOf,
  type CallDefaults,
  type Keyed,
} from './pattern-kit.js';
import { brief, bullets, numbered, promptText } from './text.js';
import {
  Claims,
  Falsification,
  Hypotheses,
  Leads,
  type Citation,
  type Hypothesis,
  type Lead,
} from './types.js';

/**
 * A settled-map item that carries its key, the rendered prompt the mapper sends, and where the call
 * runs (see `placement`).
 */
interface PromptRecord {
  readonly key: string;
  readonly prompt: string;
  readonly placement?: JsonValue;
}

/** `### <title>` followed by `body`, a subsection inside a `std.text.brief` section. */
function subsection(title: string, body: string): string {
  return `### ${title}\n\n${body}`;
}

/** `text`, or undefined when it is absent or blank, so a prompt never shows an empty section. */
function present(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === '' ? undefined : text;
}

/** Throw a `TypeError` naming the pattern when `question` is blank. */
function checkQuestion(pattern: string, question: string): string {
  if (question.trim() === '') throw new TypeError(`${pattern} needs a nonblank question.`);
  return question;
}

/** The settled result at `index`, or an error naming the item when the map returned too few. */
function settledAt<T>(
  results: readonly Settled<T, MapStepError>[],
  index: number,
  what: string,
): Settled<T, MapStepError> {
  const result = results[index];
  if (result === undefined) throw new Error(`Missing settled result for ${what}.`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// falsify
// ---------------------------------------------------------------------------------------------

/** The most hypotheses `std.types.Hypotheses` allows, so the largest valid `count`. */
const MAX_HYPOTHESES = 8;

/** The slots {@link falsify} needs: a `theorist` that proposes and a `falsifier` that tests. */
export const FalsifyTeam: ReturnType<typeof defineTeam<'theorist' | 'falsifier'>> = defineTeam({
  theorist:
    'Proposes distinct, competing explanations of what was observed, each with checkable predictions, without deciding between them. Fill with a high-effort read-only entry such as std.roles.Reviewer, or std.roles.Planner.',
  falsifier:
    'Tries to falsify one hypothesis by checking its predictions against the evidence, and answers untestable when unsure. Fill with a high-effort read-only entry such as std.roles.Skeptic.',
});
/** The team record {@link falsify} takes: `{ readonly theorist: Agent; readonly falsifier: Agent }`. */
export type FalsifyTeam = TeamOf<typeof FalsifyTeam>;

/** Replacement prompts of {@link falsify}. */
export interface FalsifyPrompts {
  /**
   * The theorist's prompt for `question`, asking for up to `count` hypotheses; the `evidence`
   * option is then unused for it. The default asks for genuinely different causes, each with a
   * mechanism and one to five checkable predictions that tell the hypotheses apart.
   */
  readonly theorize?: ((question: string, count: number) => string | Prompt) | undefined;
  /**
   * The falsifier's prompt for one hypothesis, given its rivals (every other tested hypothesis) as
   * context. The default gives the hypothesis, the rivals' causes and the evidence, and names
   * `untestable` as the safe default.
   */
  readonly falsify?:
    | ((hypothesis: Hypothesis, rivals: readonly Hypothesis[], question: string) => string | Prompt)
    | undefined;
}

/** Options of {@link falsify}. */
export interface FalsifyOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `theorist` and `falsifier` slots. */
  readonly team: FalsifyTeam;
  /** What to explain, such as `Why did checkout requests time out after the 1.4.1 deploy?`. */
  readonly question: string;
  /**
   * What was observed, shown to the theorist and every falsifier under `### Evidence`, such as a
   * commit log, error output and incident notes; the agents may also read what their tools reach.
   * Blank evidence counts as none.
   */
  readonly evidence?: string | undefined;
  /**
   * The most hypotheses to test, from 1 to 8; defaults to 4. The theorist is asked for up to this
   * many; any beyond it are logged and not tested.
   */
  readonly count?: number | undefined;
  /** Replacement prompts. */
  readonly prompts?: FalsifyPrompts | undefined;
  /** How many falsifier calls run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled map's fingerprint does not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** One tested hypothesis in a {@link FalsifyResult}. */
export interface TestedHypothesis {
  /** The hypothesis's key in the step IDs: its `id`, made unique and ID-safe. */
  readonly key: string;
  /** The hypothesis as the theorist proposed it. */
  readonly hypothesis: Hypothesis;
  /** The falsifier's verdict, reasoning and checked predictions, or null when its call failed. */
  readonly verdict: Falsification | null;
}

/**
 * How far the verdicts single out one explanation, decided in code:
 *
 * - `high`: exactly one hypothesis survives and every other one was falsified.
 * - `medium`: exactly one survives, but no rival was falsified (it was the only hypothesis, or
 *   every rival was untestable) or some rival was left open (untestable, or its falsifier failed).
 * - `split`: more than one survives.
 * - `none`: none survives.
 */
export type FalsifyConfidence = 'high' | 'medium' | 'split' | 'none';

/** Result of {@link falsify}. */
export interface FalsifyResult {
  /** Every tested hypothesis with its verdict, in the theorist's order (most plausible first). */
  readonly hypotheses: TestedHypothesis[];
  /** The hypotheses whose verdict is `survives`, in the theorist's order. */
  readonly survivors: Hypothesis[];
  /** How far the verdicts single out one explanation; see {@link FalsifyConfidence}. */
  readonly confidence: FalsifyConfidence;
  /** How many hypotheses were falsified. */
  readonly falsified: number;
  /** How many falsifier calls failed; the failures are saved, so a resume does not retry them. */
  readonly failed: number;
  /** `'complete'` when every falsifier answered, else `'degraded'`. */
  readonly status: 'complete' | 'degraded';
}

/** The default theorist prompt. */
function theorizePrompt(question: string, evidence: string | undefined, count: number): string {
  return brief({
    task: `Propose up to ${String(count)} distinct, competing hypotheses that could answer this question: ${question}`,
    context: evidence === undefined ? undefined : subsection('Evidence', evidence),
    guidance: [
      'Each hypothesis names one cause and the mechanism by which it would produce what was observed.',
      'Give each one to five predictions: observations that must hold if it is true and that can be checked against the evidence, code, logs or data. Prefer predictions that tell the hypotheses apart.',
      'Make the hypotheses genuinely different explanations rather than variants of one, and include the mundane ones (configuration, environment, data, dependencies), not only code defects.',
      'Ground every hypothesis in the evidence, but do not decide between them: each one is tested separately.',
      'Use short unique IDs: H1, H2, and so on.',
    ],
    output: 'The hypotheses, most plausible first.',
  });
}

/** The default falsifier prompt; it names `untestable` as the safe default. */
function falsifyPrompt(
  question: string,
  evidence: string | undefined,
  tested: Keyed<Hypothesis>,
  rivals: readonly Keyed<Hypothesis>[],
): string {
  const { key, item } = tested;
  const sections = [
    subsection(
      `Hypothesis ${key}`,
      `${item.cause}\n\nMechanism: ${item.mechanism}\n\nPredictions:\n\n${numbered(item.predictions)}`,
    ),
  ];
  if (rivals.length > 0) {
    const causes = rivals.map((rival) => `${rival.key}: ${rival.item.cause}`);
    sections.push(subsection('Rival hypotheses (context only)', bullets(causes)));
  }
  if (evidence !== undefined) sections.push(subsection('Evidence', evidence));
  const sources = evidence === undefined ? '' : 'the evidence above and against ';
  return brief({
    task: `Try to falsify hypothesis ${key} as the answer to this question: ${question}`,
    context: sections.join('\n\n'),
    guidance: [
      `Check each prediction against ${sources}the code, logs or data you can read yourself, looking for the observation that would contradict it.`,
      'falsified: a prediction is contradicted by evidence you can cite. survives: you checked its predictions and the evidence confirms them, with none contradicted. untestable: the available evidence can neither confirm nor contradict them.',
      'When the evidence does not settle it, answer untestable; that is the safe default. Never answer survives without evidence you checked.',
      'Test this hypothesis only: the rivals are listed so you can see which observations tell them apart, and each is tested separately.',
    ],
    output:
      'The verdict, the reasoning that decided it (citing the evidence), and in `checked` each prediction you checked with what you found.',
  });
}

/** The structural confidence of a set of verdicts; see {@link FalsifyConfidence}. */
function confidenceOf(survivors: number, falsified: number, total: number): FalsifyConfidence {
  if (survivors === 0) return 'none';
  if (survivors > 1) return 'split';
  return falsified > 0 && falsified === total - 1 ? 'high' : 'medium';
}

/**
 * Explain `question` by elimination. `team.theorist` proposes up to `count` competing hypotheses as
 * step `<id>/theorize` (schema `std.types.Hypotheses`); hypotheses beyond `count` are logged and
 * not tested. Each kept hypothesis is keyed by its `id` (made unique and ID-safe with
 * `std.data.uniqueKeys`), and `team.falsifier` tries to falsify it in the settled map
 * `<id>/hypothesis`, so hypothesis `k` records `<id>/hypothesis/<k>/falsify` (schema
 * `std.types.Falsification`), with the rivals' causes as context only.
 *
 * The confidence is decided in code from the verdicts (see {@link FalsifyConfidence}): only one
 * survivor whose every rival was falsified is `high`. A failed falsifier call is journaled, logged
 * and counted in `failed`; its hypothesis has a null verdict, is not a survivor, and keeps the
 * confidence below `high`. A failed theorist call rejects, since there is nothing to test.
 *
 * The default prompts are `std.text.brief`s: the theorist's states the question with the evidence
 * and asks for distinct causes with checkable predictions; the falsifier's gives the hypothesis,
 * its rivals and the evidence, and names `untestable` as the safe default (never `survives`
 * without checked evidence). Each map item carries its rendered prompt, so a prompt change is
 * detected on resume; set `version` when a change the prompts do not show should not reuse
 * verdicts.
 *
 * Team slots: `theorist`, a high-effort read-only entry such as `std.roles.Reviewer` (or
 * `std.roles.Planner`); `falsifier`, a skeptical read-only entry such as `std.roles.Skeptic`, or
 * a shell entry built with `std.claude.shell` when predictions need commands to check.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team and the question, with optional evidence, count and prompts.
 * @returns Every tested hypothesis with its verdict, the survivors, the confidence, the falsified
 * and failed counts, and the status.
 * @throws TypeError - Before any effect, when a team slot is not filled, `question` is blank,
 * `count` is not an integer from 1 to 8, or `concurrency` is not a positive integer.
 * @throws Error - The theorist's call failure; a resume retries it.
 */
export async function falsify(
  ctx: WorkflowContext,
  options: FalsifyOptions,
): Promise<FalsifyResult> {
  const count = positiveInt('count', options.count ?? 4);
  if (count > MAX_HYPOTHESES) {
    throw new TypeError(
      `count must be at most ${String(MAX_HYPOTHESES)} (the most std.types.Hypotheses allows); got ${String(count)}.`,
    );
  }
  const question = checkQuestion('falsify', options.question);
  const team = FalsifyTeam.from(options.team);
  const map = settledMap<PromptRecord>(options);
  const { id, calls } = options;
  const evidence = present(options.evidence);
  const custom = options.prompts;
  const theorize = promptText(
    custom?.theorize === undefined
      ? theorizePrompt(question, evidence, count)
      : custom.theorize(question, count),
  );

  return ctx.scope(id, async () => {
    const proposed = await team.theorist.value('theorize', {
      ...calls,
      prompt: theorize,
      schema: Hypotheses,
    });
    const dropped = proposed.hypotheses.slice(count);
    if (dropped.length > 0) {
      ctx.log(
        `${id}: the theorist proposed ${String(proposed.hypotheses.length)} hypotheses; testing the first ${String(count)} and not the remaining ${String(dropped.length)}.`,
        { dropped: dropped.map((hypothesis) => `${hypothesis.id}: ${hypothesis.cause}`) },
      );
    }
    const entries = keyed(proposed.hypotheses.slice(0, count), (hypothesis) => hypothesis.id);
    const records: PromptRecord[] = entries.map((entry) => {
      const rivals = entries.filter((other) => other.index !== entry.index);
      const prompt =
        custom?.falsify === undefined
          ? falsifyPrompt(question, evidence, entry, rivals)
          : custom.falsify(
              entry.item,
              rivals.map((rival) => rival.item),
              question,
            );
      return { key: entry.key, prompt: promptText(prompt), ...placement(calls) };
    });
    const settled = await ctx.map('hypothesis', records, map, (record) =>
      team.falsifier.value('falsify', { ...calls, prompt: record.prompt, schema: Falsification }),
    );

    const hypotheses = entries.map(({ key, item, index }): TestedHypothesis => {
      const outcome = settledAt(settled, index, `hypothesis ${key}`);
      return { key, hypothesis: item, verdict: outcome.ok ? outcome.value : null };
    });
    const failedKeys = hypotheses.filter((entry) => entry.verdict === null).map(({ key }) => key);
    if (failedKeys.length > 0) {
      ctx.log(
        `${id}: ${String(failedKeys.length)} of ${String(hypotheses.length)} falsifier call(s) failed; those hypotheses stay open.`,
        { failed: failedKeys },
      );
    }
    const survivors = hypotheses
      .filter((entry) => entry.verdict?.verdict === 'survives')
      .map((entry) => entry.hypothesis);
    const falsified = hypotheses.filter((entry) => entry.verdict?.verdict === 'falsified').length;
    return {
      hypotheses,
      survivors,
      confidence: confidenceOf(survivors.length, falsified, hypotheses.length),
      falsified,
      failed: failedKeys.length,
      status: statusOf(failedKeys.length),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------------------------

/** How many leads the default scout prompt asks for at most (`std.types.Leads` allows 10). */
const LEADS_PER_SCOUT = 5;

/** The slots {@link research} needs: a `scout` per angle, a `reader` per lead and a `synthesizer`. */
export const ResearchTeam: ReturnType<typeof defineTeam<'scout' | 'reader' | 'synthesizer'>> =
  defineTeam({
    scout:
      'Finds the most promising sources for one angle of a question without reading them in depth. Fill with std.roles.Researcher for web sources, or std.roles.Scout for a repository.',
    reader:
      'Reads one source and extracts the claims it establishes, each with a precise source and quote, leaving out what it cannot verify. Fill with std.roles.Researcher for web sources, or std.roles.Reader for a repository.',
    synthesizer:
      'Answers the question from the numbered claims alone, citing them and saying what they do not settle. Fill with a prose entry such as std.roles.Writer or std.roles.Scribe.',
  });
/**
 * The team record {@link research} takes:
 * `{ readonly scout: Agent; readonly reader: Agent; readonly synthesizer: Agent }`.
 */
export type ResearchTeam = TeamOf<typeof ResearchTeam>;

/** Replacement prompts of {@link research}; the `context` option shapes only the defaults. */
export interface ResearchPrompts {
  /**
   * The scout's prompt for one angle. The default gives the question and the angle's charter and
   * asks for at most five leads, best first, precise enough to open, without reading them.
   */
  readonly scout?: ((angle: Lens, question: string) => string | Prompt) | undefined;
  /**
   * The reader's prompt for one lead. The default asks for the claims the source itself
   * establishes, each with a precise source and quote, and names leaving out what cannot be
   * verified as the safe default.
   */
  readonly read?: ((lead: Lead, question: string) => string | Prompt) | undefined;
  /**
   * The synthesizer's prompt over the claims (numbered from 1 in this order) and the leads whose
   * read failed. The default asks for an answer from the claims alone, cited as `[n]`, that says
   * what the claims do not settle and ends with a Sources list.
   */
  readonly synthesize?:
    | ((question: string, claims: readonly Citation[], unread: readonly Lead[]) => string | Prompt)
    | undefined;
}

/** Options of {@link research}. */
export interface ResearchOptions {
  /** The scope for every step this pattern records. */
  readonly id: string;
  /** The agents filling the `scout`, `reader` and `synthesizer` slots. */
  readonly team: ResearchTeam;
  /** The research question. */
  readonly question: string;
  /**
   * Background every default prompt shows under the question, such as the versions in use or
   * what is already known; blank background counts as none.
   */
  readonly context?: string | undefined;
  /**
   * The source angles, one scout call each; defaults to `std.lenses.research`. A key repeated in
   * the list gets a `.2`, `.3`, ... suffix in its step IDs.
   */
  readonly angles?: readonly Lens[] | undefined;
  /**
   * The most distinct leads to read, a positive integer; defaults to 6. Leads beyond it are
   * logged and returned as `deferred`.
   */
  readonly reads?: number | undefined;
  /** Replacement prompts. */
  readonly prompts?: ResearchPrompts | undefined;
  /** How many scout calls, and separately how many reader calls, run at once; defaults to 4. */
  readonly concurrency?: number | undefined;
  /** A revision for prompts and schemas the settled maps' fingerprints do not show. */
  readonly version?: string | undefined;
  /** Options applied to every agent call (placement, retry, deadlines). */
  readonly calls?: CallDefaults | undefined;
}

/** Result of {@link research}. */
export interface ResearchResult {
  /**
   * The synthesizer's cited answer: claim `n` is cited as `[n]` and is `claims[n - 1]`. Empty when
   * no claim was collected (status `'unanswered'`).
   */
  readonly answer: string;
  /**
   * The leads the claims came from (each read returned at least one claim), in reading order. A
   * lead that was read but yielded no claim, because it was irrelevant or could not be opened, is
   * in neither this list nor `unread`.
   */
  readonly sources: Lead[];
  /**
   * The distinct claims the readers extracted, in reading order and numbered from 1 in the
   * synthesizer's prompt.
   */
  readonly claims: Citation[];
  /** The leads past the `reads` cap, in priority order; they were logged and not read. */
  readonly deferred: Lead[];
  /** The leads whose read failed; the failures are saved, so a resume does not retry them. */
  readonly unread: Lead[];
  /** How many scout calls failed. */
  readonly failedScouts: number;
  /** How many reader calls failed (the length of `unread`). */
  readonly failedReads: number;
  /**
   * `'complete'` when every scout and reader answered and the synthesizer wrote the answer,
   * `'degraded'` when some failed and the answer rests on the rest, `'unanswered'` when no claim
   * was collected, so the synthesizer was not called.
   */
  readonly status: 'complete' | 'degraded' | 'unanswered';
}

/**
 * The identity of a lead for deduplication: its `ref` trimmed and lowercased, without an
 * `http(s)://` scheme, a leading `www.` or `./`, or trailing slashes. A URL keeps its fragment only
 * when it is a client-side route (`#/...` or `#!...`, as on hash-routed documentation sites), so
 * anchors into one page share an identity while routed pages stay distinct; any other ref keeps its
 * fragment (an issue such as `owner/repo#12`) unless it is a line anchor such as `#L12`.
 */
function leadKey(lead: Lead): string {
  const ref = lead.ref.trim().toLowerCase();
  const hash = ref.indexOf('#');
  const base = hash < 0 ? ref : ref.slice(0, hash);
  let fragment = hash < 0 ? '' : ref.slice(hash).replace(/\/+$/u, '');
  const isUrl = /^https?:\/\//u.test(base);
  const anchor = isUrl ? !/^#[/!]/u.test(fragment) : /^#l\d+(?:-l?\d+)?$/u.test(fragment);
  if (anchor || /^#!?$/u.test(fragment)) fragment = '';
  const location = base
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/^\.\//u, '')
    .replace(/\/+$/u, '');
  return location + fragment;
}

/**
 * Merge the scouts' lists into one priority order: leads named by more scouts first, then by rank
 * across the scouts in turn (every scout's first lead, then every second lead, ...), deduplicated
 * by {@link leadKey} with the first occurrence kept.
 */
function rankLeads(lists: readonly (readonly Lead[])[]): Lead[] {
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const interleaved: Lead[] = [];
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const lead = list[rank];
      if (lead !== undefined) interleaved.push(lead);
    }
  }
  const counts = new Map(corroborate(lists, leadKey).map((entry) => [entry.key, entry.count]));
  // Array.prototype.sort is stable, so equal counts keep the interleaved order.
  return dedupeBy(interleaved, leadKey)
    .map((lead) => ({ lead, count: counts.get(leadKey(lead)) ?? 1 }))
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.lead);
}

/** The question and the optional background, as the context of a default research prompt. */
function questionContext(question: string, background: string | undefined): string[] {
  const sections = [subsection('Question', question)];
  if (background !== undefined) sections.push(subsection('Background', background));
  return sections;
}

/** The default scout prompt for one angle. */
function scoutPrompt(angle: Lens, question: string, background: string | undefined): string {
  return brief({
    task: `Find the sources most likely to answer the research question below, searching from one angle only, ${angle.key}: ${angle.charter}`,
    context: questionContext(question, background).join('\n\n'),
    guidance: [
      'Locate sources; do not read them in depth or answer the question: other agents read the leads you return, and others cover the other angles.',
      'Name each source precisely enough to open it directly: a URL, a repository path, a package name or an identifier.',
      'Prefer primary and current sources for the version in question, and say what each one should reveal.',
      `Return at most ${String(LEADS_PER_SCOUT)} leads, best first. An empty list is a valid answer when this angle has nothing relevant.`,
    ],
    output: 'The leads, best first, each with what it should reveal.',
  });
}

/** The default reader prompt for one lead; leaving out what cannot be verified is the safe default. */
function readPrompt(lead: Lead, question: string, background: string | undefined): string {
  const sections = questionContext(question, background);
  sections.push(subsection('Source', `${lead.ref}\n\nExpected to reveal: ${lead.why}`));
  return brief({
    task: 'Read the source below and extract the claims it establishes that bear on the research question.',
    context: sections.join('\n\n'),
    guidance: [
      'Open and read the source itself. If you cannot open it, return no claims rather than recalling what it might say.',
      'Record only claims this source establishes, each with a precise source (a URL with an anchor, a file:line, a commit SHA or a log line) and the exact supporting quote where there is one.',
      'Include claims that contradict or qualify the likely answer, and state the version or date a claim applies to.',
      'When you cannot verify a claim in the source, leave it out; that is the safe default. An empty list is a valid answer when the source does not bear on the question.',
    ],
    output: 'The claims, each with its source and the quote that supports it.',
  });
}

/** One numbered claim entry of the synthesizer prompt: the claim, its source and its quote. */
function claimEntry(claim: Citation): string {
  const lines = [claim.claim, `Source: ${claim.source}`];
  if (claim.quote !== null) lines.push(`Quote: ${claim.quote}`);
  return lines.join('\n');
}

/** The default synthesizer prompt over the numbered claims. */
function synthesizePrompt(
  question: string,
  background: string | undefined,
  claims: readonly Citation[],
  unread: readonly Lead[],
): string {
  const sections = questionContext(question, background);
  sections.push(subsection('Claims', numbered(claims.map(claimEntry))));
  const guidance = [
    'Use only the claims above and add no facts of your own: each was extracted from its source by a reader.',
    'Cite every statement with the numbers of the claims it rests on, such as [2] or [1, 4].',
    'Where claims conflict, say so and give each side with its citations, preferring primary and more recent sources.',
    'When the claims do not settle the question, say so plainly instead of guessing.',
  ];
  if (unread.length > 0) {
    sections.push(subsection('Not read', bullets(unread.map((lead) => lead.ref))));
    guidance.push(
      'The sources under "Not read" could not be read: say that the answer does not reflect them, and do not guess what they contain.',
    );
  }
  return brief({
    task: 'Answer the research question below from the numbered claims only.',
    context: sections.join('\n\n'),
    guidance,
    output:
      'The answer in Markdown: the direct answer first, then the supporting detail, then a "Sources" list that maps each cited number to its source.',
  });
}

/**
 * Research `question` in three stages. One `team.scout` call per angle forms the settled map
 * `<id>/scout`, keyed by angle key, so angle `a` records `<id>/scout/<a>/leads` (schema
 * `std.types.Leads`). The leads are merged into one priority order (leads several scouts named
 * first, then by rank, taking each scout's leads in turn), deduplicated by reference (compared
 * case-insensitively without an `http(s)://` scheme, `www.`, `./` or trailing slash, and without
 * a URL's in-page anchor or a `#L12` line anchor; a hash route such as `#/docs/api/Pool` and an
 * issue such as `owner/repo#12` stay distinct), and capped at `reads`; the deferred rest is logged
 * and returned. Each chosen lead is
 * one `team.reader` call in the settled map `<id>/read`, keyed by its reference made ID-safe with
 * `std.data.uniqueKeys` (`ctx.id(ref)` for a unique reference), so lead `l` records
 * `<id>/read/<l>/claims` (schema `std.types.Claims`). The distinct claims, numbered in reading
 * order, go to `team.synthesizer` as the text call `<id>/synthesize`, which cites them as `[n]`.
 * Without any lead nothing is read, and without any claim the synthesizer is not called: the
 * answer is empty and the status `'unanswered'`.
 *
 * A failed scout or reader call is journaled, logged and counted, so a resume does not retry it;
 * the synthesizer is told which sources could not be read. The default prompts are
 * `std.text.brief`s that show the question and the `context` background; the reader's names
 * leaving out an unverifiable claim as the safe default, and the synthesizer's asks it to say
 * what the claims do not settle rather than guess. Each map item carries its rendered prompt, so a
 * prompt change is detected on resume.
 *
 * Team slots: `scout`, `std.roles.Researcher` for web sources or `std.roles.Scout` for a
 * repository; `reader`, `std.roles.Researcher` or `std.roles.Reader`; `synthesizer`, a prose
 * entry such as `std.roles.Writer` (no tools, so it writes from the claims alone) or
 * `std.roles.Scribe`.
 *
 * @param ctx - The workflow context the team was bound from.
 * @param options - The scope, the team and the question, with optional background, angles, read
 * cap and prompts.
 * @returns The cited answer, the leads the claims came from, the claims, the deferred and unread
 * leads, the failure counts and the status.
 * @throws TypeError - Before any effect, when a team slot is not filled, `question` is blank,
 * `angles` is empty, or `reads` or `concurrency` is not a positive integer.
 * @throws Error - The synthesizer's call failure; a resume replays the scouts and readers and
 * retries only the synthesizer.
 */
export async function research(
  ctx: WorkflowContext,
  options: ResearchOptions,
): Promise<ResearchResult> {
  const question = checkQuestion('research', options.question);
  const angles = nonEmpty('angles', options.angles ?? researchAngles).slice();
  const reads = positiveInt('reads', options.reads ?? 6);
  const team = ResearchTeam.from(options.team);
  const map = settledMap<PromptRecord>(options);
  const { id, calls } = options;
  const background = present(options.context);
  const custom = options.prompts;
  const scouts = keyed(angles, (angle) => angle.key);
  const scoutRecords: PromptRecord[] = scouts.map(({ key, item }) => ({
    key,
    prompt: promptText(
      custom?.scout === undefined
        ? scoutPrompt(item, question, background)
        : custom.scout(item, question),
    ),
    ...placement(calls),
  }));

  return ctx.scope(id, async () => {
    const scouted = await ctx.map('scout', scoutRecords, map, (record) =>
      team.scout.value('leads', { ...calls, prompt: record.prompt, schema: Leads }),
    );
    const lists: Lead[][] = [];
    const failedAngles: string[] = [];
    for (const { key, index } of scouts) {
      const outcome = settledAt(scouted, index, `angle ${key}`);
      if (outcome.ok) lists.push(outcome.value.leads);
      else failedAngles.push(key);
    }
    if (failedAngles.length > 0) {
      ctx.log(
        `${id}: ${String(failedAngles.length)} of ${String(scouts.length)} scout call(s) failed.`,
        { failed: failedAngles },
      );
    }
    const ranked = rankLeads(lists);
    const chosen = ranked.slice(0, reads);
    const deferred = ranked.slice(reads);
    if (deferred.length > 0) {
      ctx.log(
        `${id}: the scouts named ${String(ranked.length)} distinct leads; reading the first ${String(reads)} and deferring ${String(deferred.length)}.`,
        { deferred: deferred.map((lead) => lead.ref) },
      );
    }
    const unanswered = (reason: string, unread: Lead[]): ResearchResult => {
      ctx.log(`${id}: ${reason}; the question is unanswered.`);
      return {
        answer: '',
        sources: [],
        claims: [],
        deferred,
        unread,
        failedScouts: failedAngles.length,
        failedReads: unread.length,
        status: 'unanswered',
      };
    };
    if (chosen.length === 0) return unanswered('no scout named a lead', []);

    const leads = keyed(chosen, (lead) => lead.ref);
    const readRecords: PromptRecord[] = leads.map(({ key, item }) => ({
      key,
      prompt: promptText(
        custom?.read === undefined
          ? readPrompt(item, question, background)
          : custom.read(item, question),
      ),
      ...placement(calls),
    }));
    const read = await ctx.map('read', readRecords, map, (record) =>
      team.reader.value('claims', { ...calls, prompt: record.prompt, schema: Claims }),
    );
    const sources: Lead[] = [];
    const unread: Lead[] = [];
    const extracted: Citation[] = [];
    for (const { key, item, index } of leads) {
      const outcome = settledAt(read, index, `lead ${key}`);
      if (!outcome.ok) {
        unread.push(item);
      } else if (outcome.value.claims.length > 0) {
        sources.push(item);
        extracted.push(...outcome.value.claims);
      }
    }
    if (unread.length > 0) {
      ctx.log(`${id}: ${String(unread.length)} of ${String(leads.length)} reader call(s) failed.`, {
        unread: unread.map((lead) => lead.ref),
      });
    }
    const claims = dedupeBy(
      extracted,
      (claim) => `${normalizeTitle(claim.claim)}::${claim.source.trim()}`,
    );
    if (claims.length === 0) return unanswered('the readers found no claims', unread);

    const prompt =
      custom?.synthesize === undefined
        ? synthesizePrompt(question, background, claims, unread)
        : custom.synthesize(question, claims, unread);
    const answer = await team.synthesizer.value('synthesize', { ...calls, prompt });
    return {
      answer,
      sources,
      claims,
      deferred,
      unread,
      failedScouts: failedAngles.length,
      failedReads: unread.length,
      status: failedAngles.length + unread.length === 0 ? 'complete' : 'degraded',
    };
  });
}
