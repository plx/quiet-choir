// release-gate: control flow only. Code pins the range on a checkout that is exactly HEAD and runs
// the operator's tests (the tests verdict) and evidence commands there; settled maps assess five
// dimensions and confirm each reported blocker, each reader in its own unchanged checkout of the
// pinned commit, and the code-owned gate rule bounds what the gatekeeper may decide.
import { defineWorkflow } from 'quiet-choir';
import {
  Assessed,
  Assessment,
  Confirmation,
  DecisionFor,
  ReleaseGateInput,
  ReleaseGateOutput,
} from '../contracts.js';
import { forDimension, gatherEvidence, runTests } from '../lib/checks.js';
import { dirt, gitWindow, rangeLog, rangePatch } from '../lib/git.js';
import {
  assessedRow,
  changedByCommands,
  confirm,
  fallback,
  gate,
  groups,
  head,
  notHead,
  ran,
  refused,
  report,
  testsRow,
  unchanged,
  unverified,
} from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

// Every role only reads, so one more attempt is safe; a fault that outlasts it settles.
const retry = { maxAttempts: 2, on: ['schema', 'transient', 'process'] } as const;

export default defineWorkflow({
  name: 'release-gate',
  version: 'packaged-03',
  description:
    'Gate a checkout that is exactly HEAD on code-run tests and evidence, settled pinned readers, and a code-owned rule.',
  phases: [
    { title: 'Assess', detail: 'code-run tests and evidence, five read-only assessors' },
    { title: 'Confirm', detail: 'an independent skeptic per reported blocker' },
    { title: 'Decide', detail: 'the gatekeeper chooses among what the code-owned rule allows' },
  ],
  roster,
  prompts: [prompts],
  input: ReleaseGateInput,
  output: ReleaseGateOutput,
  async run(ctx, input) {
    const { policy } = input;
    const blockOn = [...new Set(input.blockOn)];
    const none = { since: null, start: null, end: null, manifest: [] };
    // The operator's commands must see HEAD's tree: no tracked change and no untracked file.
    const before = await dirt(ctx, 'clean', true);
    if (before.length) return refused(notHead(before), blockOn, none);
    const window = await gitWindow(ctx.within('range'), input.since, input.tagPattern);
    if (!window.ok) return refused(window.reason, blockOn, none);
    const { start, end, manifest } = window;
    // Every reader works in its own unchanged checkout of the pinned end.
    const pinned = { worktree: { base: { commit: end } } };
    const span = `${window.since}..HEAD`;
    if (!manifest.length) return refused(`Nothing ships: ${span} has no commits.`, blockOn, window);
    ctx.phase('Assess');
    const log = head(await rangeLog(ctx, start, end), input.maxPatchChars);
    const patch = head(await rangePatch(ctx, start, end), input.maxPatchChars);
    const range = { span, count: manifest.length, log, patch };
    const tests = await runTests(ctx, input.testCommands, input.commandTimeoutMs);
    const evidence = await gatherEvidence(ctx, input.evidenceCommands, input.commandTimeoutMs);
    // A command that rewrote a tracked file ran later commands on another tree; its untracked
    // artifacts (coverage, caches) are allowed and never reach the pinned readers.
    const after = await dirt(ctx, 'clean-after-commands', false);
    if (after.length)
      return refused(changedByCommands(after), blockOn, window, ran(tests, evidence));
    // Items carry each dimension's command output, so the settled fingerprint covers it;
    // `version` names the prompt and schema, which the fingerprint does not show.
    const items = Assessed.options.map((dimension) => forDimension(evidence, dimension));
    const assessed = await ctx.map(
      'dimensions',
      items,
      { concurrency: 3, onError: 'return', key: (item) => item.dimension, version: 'assess/3' },
      async (item) =>
        unchanged(
          await ctx.roster.Assessor.object('assess', {
            schema: Assessment,
            retry,
            ...pinned,
            prompt: prompts.Assess({ ...item, policy, ...range }),
          }),
        ),
    );
    const rows = [
      testsRow(tests, input.commandTimeoutMs),
      ...items.map((item, index) => assessedRow(item.dimension, assessed[index])),
    ];
    // Code's own test verdict needs no confirmer; every blocker an assessor reported faces one,
    // with the same command output its assessor judged.
    const flagged = rows.filter((row) => row.source === 'assessor' && row.reported === 'blocker');
    ctx.log(`${String(flagged.length)} reported blocker(s) to confirm`);
    ctx.phase('Confirm');
    const confirmations = await ctx.map(
      'confirmations',
      flagged.map(({ dimension, evidence: why, findings }) => ({
        ...forDimension(evidence, dimension),
        evidence: why,
        findings,
      })),
      { concurrency: 3, onError: 'return', key: (item) => item.dimension, version: 'confirm/3' },
      async (item) =>
        unchanged(
          await ctx.roster.Confirmer.object('confirm', {
            schema: Confirmation,
            retry,
            ...pinned,
            prompt: prompts.Confirm({ ...item, policy, ...range }),
          }),
        ),
    );
    const judged = confirm(rows, flagged, confirmations);
    const { rule, allowed } = gate(judged, blockOn);
    ctx.phase('Decide');
    ctx.log(`Gate rule ${rule} allows ${allowed.join(' or ')}`);
    const decided = await ctx.roster.Gatekeeper.value('gatekeeper', {
      schema: DecisionFor(allowed),
      onError: 'return',
      retry,
      prompt: prompts.Decide({
        span,
        policy,
        blockOn,
        rule,
        ...groups(judged, blockOn),
        unverified: unverified(judged, blockOn),
      }),
    });
    return report({
      ...(decided.ok ? decided.value : fallback(judged, blockOn, allowed)),
      decidedBy: decided.ok ? 'gatekeeper' : 'code',
      allowed,
      window,
      blockOn,
      dimensions: judged,
      tests,
      evidence,
      log,
      patch,
    });
  },
});
