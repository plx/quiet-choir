// Idiomatic rewrite of the pinned MIT upstream; see ../LICENSE and ../notes.json.
import { defineWorkflow, z } from 'quiet-choir';
import { Path, json, profiles } from './support.js';

const Bug = z.object({
  title: z.string().min(1),
  file: Path,
  line: z.number().int().min(1).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  evidence: z.string().min(1),
  failureScenario: z.string().min(1),
});
const Finding = z.object({
  bug: Bug,
  outcome: z.enum(['confirmed', 'refuted', 'undecided']),
  upheld: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
});
const lenses = [
  'error handling',
  'boundaries',
  'concurrency',
  'resource lifecycle',
  'state machines',
  'contracts',
  'time and ordering',
  'input validation',
];
export default defineWorkflow({
  name: 'bug-hunt',
  version: 'idiomatic-02',
  description:
    'Run settled finder and skeptic panels, preserve uncertainty, and bound logical admissions.',
  profiles: { reader: profiles.reader },
  input: z.object({
    scope: z.string().min(1).describe('Repository area to inspect'),
    maxRounds: z.number().int().min(1).max(8).default(4),
    votes: z.number().int().min(1).max(7).default(3),
    maxCalls: z
      .number()
      .int()
      .min(3)
      .max(200)
      .default(60)
      .describe(
        'Logical call admissions; also set --max-run-cost-usd for reported spend including failed attempts',
      ),
  }),
  output: z.object({
    status: z.enum(['complete', 'degraded', 'call-limit']),
    rounds: z.number().int().nonnegative(),
    dryRounds: z.number().int().nonnegative(),
    callsAdmitted: z.number().int().nonnegative(),
    failedFinders: z.number().int().nonnegative(),
    failedSkeptics: z.number().int().nonnegative(),
    skippedSkeptics: z.number().int().nonnegative(),
    undecided: z.number().int().nonnegative(),
    findings: z.array(Finding),
  }),
  async run(ctx, input) {
    let rounds = 0,
      dryRounds = 0,
      callsAdmitted = 0,
      failedFinders = 0,
      failedSkeptics = 0,
      skippedSkeptics = 0;
    const findings: z.infer<typeof Finding>[] = [];
    const seen = new Set<string>();
    const majority = Math.floor(input.votes / 2) + 1;
    while (rounds < input.maxRounds && dryRounds < 2 && callsAdmitted + 3 <= input.maxCalls) {
      const round = ctx.within(ctx.id('round', rounds++));
      const panel = Array.from(
        { length: 3 },
        (_, index) => lenses[((rounds - 1) * 3 + index) % lenses.length],
      );
      callsAdmitted += panel.length;
      const found = await round.map(
        'finders',
        panel,
        { concurrency: 3, onError: 'settle' },
        (lens) =>
          round.claude.value('find', {
            profile: 'reader',
            schema: z.object({ bugs: z.array(Bug).max(20) }),
            prompt: `Hunt concrete runtime bugs in ${input.scope}; lens: ${lens}. Cite evidence and a reproducible failure scenario. An empty list is valid. Round ${rounds}.`,
          }),
      );
      const failed = found.filter((result) => !result.ok).length;
      failedFinders += failed;
      const fresh = found
        .flatMap((result) => (result.ok ? result.value.bugs : []))
        .filter((bug) => {
          const key = `${bug.file}:${bug.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, ' ')
            .trim()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      dryRounds = !failed && !fresh.length ? dryRounds + 1 : 0;
      for (const [index, bug] of fresh.entries()) {
        const votes = Math.min(input.votes, input.maxCalls - callsAdmitted);
        callsAdmitted += votes;
        skippedSkeptics += input.votes - votes;
        const results = await round.map(
          ctx.id('skeptics', index),
          Array.from({ length: votes }, (_, vote) => vote),
          { concurrency: 3, onError: 'settle' },
          (vote) =>
            round.claude.value('verify', {
              profile: 'reader',
              schema: z.object({ refuted: z.boolean(), reasoning: z.string().min(1) }),
              prompt: `Independently try to refute this candidate. Panel seat ${vote + 1}/${input.votes}.\n${json(bug)}`,
            }),
        );
        failedSkeptics += results.filter((result) => !result.ok).length;
        const ok = results.flatMap((result) => (result.ok ? [result.value] : []));
        const upheld = ok.filter((verdict) => !verdict.refuted).length;
        const missing = input.votes - ok.length;
        findings.push({
          bug,
          outcome:
            upheld >= majority
              ? 'confirmed'
              : upheld + missing >= majority
                ? 'undecided'
                : 'refuted',
          upheld,
          missing,
          reasons: ok.map((verdict) => verdict.reasoning),
        });
      }
    }
    const undecided = findings.filter((finding) => finding.outcome === 'undecided').length;
    const limited =
      skippedSkeptics > 0 ||
      (rounds < input.maxRounds && dryRounds < 2 && callsAdmitted + 3 > input.maxCalls);
    return {
      status: limited
        ? 'call-limit'
        : failedFinders || failedSkeptics || undecided
          ? 'degraded'
          : 'complete',
      rounds,
      dryRounds,
      callsAdmitted,
      failedFinders,
      failedSkeptics,
      skippedSkeptics,
      undecided,
      findings,
    };
  },
});
