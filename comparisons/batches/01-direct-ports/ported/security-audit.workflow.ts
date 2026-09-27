// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'security-audit',
  description:
    'Map the attack surface, sweep it with six specialist lenses, refute findings with severity-scaled panels, and write a remediation report',
  whenToUse:
    'Defensive security audit of your own codebase — before launch, after inheriting code, or as a periodic sweep of sensitive surfaces',
  phases: [
    { title: 'Recon', detail: 'map entry points, trust boundaries, secrets' },
    { title: 'Sweep', detail: 'six specialist auditors over the mapped surface' },
    { title: 'Refute', detail: 'severity-scaled skeptic panels' },
    { title: 'Report', detail: 'ranked findings with remediations' },
  ],
};
export const input = z.object({
  ...executionInput,
  scope: z.string().optional(),
  lenses: z.array(z.string()).optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const SURFACE_SCHEMA = z
      .object({
        entryPoints: z
          .array(z.string())
          .describe(
            'HTTP routes, CLI args, file/queue consumers, webhooks — where external data enters',
          ),
        trustBoundaries: z
          .array(z.string())
          .describe('where authn/authz decisions happen, and what each boundary protects'),
        secretsHandling: z
          .array(z.string())
          .describe('where credentials/tokens/keys are read, stored, or transmitted')
          .optional(),
        dependencies: z
          .array(z.string())
          .describe('security-relevant third-party deps (crypto, auth, parsers) and versions')
          .optional(),
        summary: z.string(),
      })
      .catchall(z.json());

    const FINDINGS_SCHEMA = z
      .object({
        findings: z.array(
          z
            .object({
              title: z.string(),
              file: z.string(),
              line: z.number().optional(),
              severity: z.enum(['critical', 'high', 'medium', 'low']),
              evidence: z.string(),
              attackScenario: z
                .string()
                .describe('who can trigger it, from where, with what preconditions'),
              remediation: z.string().describe('concrete fix, not "validate input"'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const VERDICT_SCHEMA = z
      .object({ refuted: z.boolean(), reasoning: z.string() })
      .catchall(z.json());

    const ALL_LENSES = [
      {
        key: 'injection',
        charter:
          'SQL/NoSQL/command/template injection, unsafe string interpolation into interpreters, path traversal in file operations',
      },
      {
        key: 'auth',
        charter:
          'missing or bypassable authn/authz checks, IDOR, privilege escalation, session fixation, insecure token validation, confused-deputy patterns',
      },
      {
        key: 'secrets',
        charter:
          'hardcoded credentials, secrets in logs or error messages, secrets in URLs or client-visible config, weak secret storage',
      },
      {
        key: 'supply-chain',
        charter:
          'dependencies with known CVEs, install scripts, typosquat-adjacent names, unpinned versions of security-critical packages',
      },
      {
        key: 'crypto-storage',
        charter:
          'weak or home-rolled crypto, ECB/static-IV misuse, missing encryption of sensitive data at rest, PII in plaintext logs',
      },
      {
        key: 'request-forgery',
        charter:
          'SSRF via user-controlled URLs, missing CSRF protection on state-changing routes, open redirects, DNS-rebinding-prone fetches',
      },
    ];

    // --------------------------------------------------------------------------
    // Phase 1: Recon — the map that makes every auditor specific.
    // --------------------------------------------------------------------------

    port.phase('Recon');

    const scope = (args && args.scope) || 'the entire repository';

    const surface = await ctx.claude
      .object(port.id('agent-1', 'recon'), {
        ...args.$claude,
        prompt: `Map the attack surface of ${scope} for a defensive security audit.
   Find: (1) every entry point where external data enters, (2) trust boundaries
   and what each protects, (3) everywhere secrets are read/stored/transmitted,
   (4) security-relevant third-party dependencies with versions.
   Report the map only — do not audit yet.`,
        schema: SURFACE_SCHEMA,
      })
      .then((result) => result.output);

    if (!surface)
      return { surface: null, confirmed: [], refuted: [], report: 'Recon failed; audit aborted.' };
    port.log(
      `Surface mapped: ${surface.entryPoints.length} entry points, ${surface.trustBoundaries.length} trust boundaries`,
    );

    // --------------------------------------------------------------------------
    // Phases 2+3: Sweep -> Refute as a PIPELINE. Unlike deep-code-review, we skip
    // the dedupe barrier: security lenses overlap far less than review dimensions
    // (an IDOR and an SSRF are never the same finding), so cross-lens dedupe buys
    // little and the barrier would idle five finished lenses while the slowest
    // auditor works. Wall-clock wins; occasional double-verify is the price.
    // --------------------------------------------------------------------------

    const lenses =
      args && args.lenses ? ALL_LENSES.filter((l) => args.lenses.includes(l.key)) : ALL_LENSES;

    const PANEL_SIZE = { critical: 3, high: 3, medium: 1, low: 1 };

    const results = await port.pipeline(
      'pipeline-1',
      lenses,

      // Stage 1: specialist sweep, armed with the recon map.
      (l) =>
        ctx.claude
          .object(port.id('agent-2', `sweep:${l.key}`), {
            ...args.$claude,
            prompt: `Defensive security audit of ${scope}. Your specialty: ${l.charter}.

     Attack-surface map from recon:
     - Entry points: ${surface.entryPoints.join('; ')}
     - Trust boundaries: ${surface.trustBoundaries.join('; ')}
     - Secrets handling: ${(surface.secretsHandling || []).join('; ') || 'none identified'}
     - Notable deps: ${(surface.dependencies || []).join('; ') || 'none identified'}

     Audit the code these point at, plus anywhere else your specialty applies.
     Report only findings with a concrete attack scenario naming who can trigger
     it and from where. Include a specific remediation per finding. Do not report
     hardening suggestions with no attack path. Empty findings is a valid result.`,
            schema: FINDINGS_SCHEMA,
            // Original phase: 'Sweep' — no matching ClaudeOptions control.
          })
          .then((result) => result.output),

      // Stage 2: refutation panels, sized by claimed severity. Runs per-lens as
      // soon as that lens's sweep returns. Note phase comes via opts here — calling
      // the global phase() inside a pipeline stage would race with other items.
      (review, l) =>
        port.parallel(
          'parallel-1',
          (review ? review.findings : []).map((f) => () => {
            const n = PANEL_SIZE[f.severity] || 1;
            return port
              .parallel(
                'parallel-2',
                Array.from(
                  { length: n },
                  (_, v) => () =>
                    ctx.claude
                      .object(port.id('agent-3', `refute:${l.key}:${v}`), {
                        ...args.$claude,
                        prompt: `Skeptic ${v + 1}/${n}: REFUTE this security finding by reading the code.
         Claim: ${f.title} (${f.severity}) at ${f.file}${f.line ? ':' + f.line : ''}
         Evidence: ${f.evidence}
         Attack scenario: ${f.attackScenario}
         Check: is the input actually attacker-controlled? Is there sanitization,
         a framework guard, or an authz check upstream that the auditor missed? Is
         the "vulnerable" path reachable in production configuration? Default to
         refuted=true if the attack scenario cannot be shown to be reachable.`,
                        schema: VERDICT_SCHEMA,
                        // Original phase: 'Refute'; effort: 'high' — no matching ClaudeOptions control.
                      })
                      .then((result) => result.output),
                ),
              )
              .then((verdicts) => {
                const upheld = verdicts.filter(Boolean).filter((x) => !x.refuted).length;
                return {
                  ...f,
                  lens: l.key,
                  upheld: `${upheld}/${n}`,
                  survives: upheld >= Math.floor(n / 2) + 1,
                };
              });
          }),
        ),
    );

    const judged = results.filter(Boolean).flat().filter(Boolean);
    const confirmed = judged.filter((f) => f.survives);
    const refuted = judged.filter((f) => !f.survives);
    port.log(
      `${confirmed.length} confirmed, ${refuted.length} refuted across ${lenses.length} lenses`,
    );

    // --------------------------------------------------------------------------
    // Phase 4: Report.
    // --------------------------------------------------------------------------

    port.phase('Report');

    const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
    confirmed.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

    const report =
      confirmed.length === 0
        ? `Audited ${scope} across ${lenses.length} lenses over a mapped surface of ${surface.entryPoints.length} entry points. ${judged.length} candidate findings; none survived refutation.`
        : await ctx.claude
            .text(port.id('agent-4', 'report'), {
              ...args.$claude,
              prompt: `Write a security-audit report in markdown.
       Surface summary: ${surface.summary}
       Confirmed findings (already refutation-tested): ${JSON.stringify(confirmed, null, 2)}
       For each: impact in one sentence, the attack scenario, and the remediation.
       Group by severity. Close with the top 3 systemic patterns you see across
       findings (e.g. "input validation is ad hoc at every boundary"). Return only
       markdown.`,

              // Original effort: 'low' — no matching ClaudeOptions control.
            })
            .then((result) => result.output);

    return {
      surface: surface.summary,
      confirmed,
      refuted: refuted.map((f) => ({ title: f.title, lens: f.lens, upheld: f.upheld })),
      report,
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});
