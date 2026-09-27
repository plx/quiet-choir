/**
 * security-audit — recon-informed, multi-lens defensive security sweep
 * ====================================================================
 *
 * USE CASE
 *   A defensive audit of your own codebase. Generic "check for vulnerabilities"
 *   prompts produce generic results; this workflow first builds a map of the
 *   actual attack surface (entry points, trust boundaries, secrets handling),
 *   then hands that map to six specialist auditors so each one hunts where
 *   this codebase is actually exposed. Findings are refutation-tested with
 *   panel size scaled to claimed severity — a "critical" needs to survive
 *   three skeptics, a "low" needs one.
 *
 *   Scope note: this is for auditing code you own or are authorized to audit,
 *   producing findings + remediations. It does not produce exploits.
 *
 * WHEN TO USE
 *   - Before exposing a service to the internet or adding an auth surface
 *   - Onboarding an inherited codebase whose security posture is unknown
 *   - Periodic sweeps of anything handling user data or money
 *
 * ARGS
 *   { scope?: string, lenses?: string[] }
 *   - scope: what to audit (default: whole repo)
 *   - lenses: subset of lens keys to run (default: all six)
 *
 * PATTERNS DEMONSTRATED
 *   - Recon-then-sweep: one cheap mapping agent makes six auditors specific
 *   - Pipeline (NO barrier between sweep and refute): each lens's findings go
 *     to refutation the moment that lens finishes — the injection auditor's
 *     findings don't wait for the crypto auditor
 *   - Severity-scaled verification: panel size proportional to claimed impact
 *   - Per-item `phase` option inside pipeline stages (global phase() would
 *     race across concurrent items)
 *
 * COST PROFILE
 *   1 recon + 6 auditors + 1-3 refuters per finding + 1 report.
 *   Typically 12-25 agents on a service-sized codebase.
 *
 * OUTPUT
 *   { surface, confirmed: [...], refuted: [...], report: "markdown" }
 */

export const meta = {
  name: 'security-audit',
  description: 'Map the attack surface, sweep it with six specialist lenses, refute findings with severity-scaled panels, and write a remediation report',
  whenToUse: 'Defensive security audit of your own codebase — before launch, after inheriting code, or as a periodic sweep of sensitive surfaces',
  phases: [
    { title: 'Recon', detail: 'map entry points, trust boundaries, secrets' },
    { title: 'Sweep', detail: 'six specialist auditors over the mapped surface' },
    { title: 'Refute', detail: 'severity-scaled skeptic panels' },
    { title: 'Report', detail: 'ranked findings with remediations' },
  ],
}

const SURFACE_SCHEMA = {
  type: 'object',
  required: ['entryPoints', 'trustBoundaries', 'summary'],
  properties: {
    entryPoints: { type: 'array', items: { type: 'string' }, description: 'HTTP routes, CLI args, file/queue consumers, webhooks — where external data enters' },
    trustBoundaries: { type: 'array', items: { type: 'string' }, description: 'where authn/authz decisions happen, and what each boundary protects' },
    secretsHandling: { type: 'array', items: { type: 'string' }, description: 'where credentials/tokens/keys are read, stored, or transmitted' },
    dependencies: { type: 'array', items: { type: 'string' }, description: 'security-relevant third-party deps (crypto, auth, parsers) and versions' },
    summary: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'evidence', 'attackScenario', 'remediation'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string' },
          attackScenario: { type: 'string', description: 'who can trigger it, from where, with what preconditions' },
          remediation: { type: 'string', description: 'concrete fix, not "validate input"' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: { refuted: { type: 'boolean' }, reasoning: { type: 'string' } },
}

const ALL_LENSES = [
  { key: 'injection', charter: 'SQL/NoSQL/command/template injection, unsafe string interpolation into interpreters, path traversal in file operations' },
  { key: 'auth', charter: 'missing or bypassable authn/authz checks, IDOR, privilege escalation, session fixation, insecure token validation, confused-deputy patterns' },
  { key: 'secrets', charter: 'hardcoded credentials, secrets in logs or error messages, secrets in URLs or client-visible config, weak secret storage' },
  { key: 'supply-chain', charter: 'dependencies with known CVEs, install scripts, typosquat-adjacent names, unpinned versions of security-critical packages' },
  { key: 'crypto-storage', charter: 'weak or home-rolled crypto, ECB/static-IV misuse, missing encryption of sensitive data at rest, PII in plaintext logs' },
  { key: 'request-forgery', charter: 'SSRF via user-controlled URLs, missing CSRF protection on state-changing routes, open redirects, DNS-rebinding-prone fetches' },
]

// --------------------------------------------------------------------------
// Phase 1: Recon — the map that makes every auditor specific.
// --------------------------------------------------------------------------

phase('Recon')

const scope = (args && args.scope) || 'the entire repository'

const surface = await agent(
  `Map the attack surface of ${scope} for a defensive security audit.
   Find: (1) every entry point where external data enters, (2) trust boundaries
   and what each protects, (3) everywhere secrets are read/stored/transmitted,
   (4) security-relevant third-party dependencies with versions.
   Report the map only — do not audit yet.`,
  { label: 'recon', schema: SURFACE_SCHEMA },
)

if (!surface) return { surface: null, confirmed: [], refuted: [], report: 'Recon failed; audit aborted.' }
log(`Surface mapped: ${surface.entryPoints.length} entry points, ${surface.trustBoundaries.length} trust boundaries`)

// --------------------------------------------------------------------------
// Phases 2+3: Sweep -> Refute as a PIPELINE. Unlike deep-code-review, we skip
// the dedupe barrier: security lenses overlap far less than review dimensions
// (an IDOR and an SSRF are never the same finding), so cross-lens dedupe buys
// little and the barrier would idle five finished lenses while the slowest
// auditor works. Wall-clock wins; occasional double-verify is the price.
// --------------------------------------------------------------------------

const lenses = (args && args.lenses)
  ? ALL_LENSES.filter(l => args.lenses.includes(l.key))
  : ALL_LENSES

const PANEL_SIZE = { critical: 3, high: 3, medium: 1, low: 1 }

const results = await pipeline(
  lenses,

  // Stage 1: specialist sweep, armed with the recon map.
  (l) => agent(
    `Defensive security audit of ${scope}. Your specialty: ${l.charter}.

     Attack-surface map from recon:
     - Entry points: ${surface.entryPoints.join('; ')}
     - Trust boundaries: ${surface.trustBoundaries.join('; ')}
     - Secrets handling: ${(surface.secretsHandling || []).join('; ') || 'none identified'}
     - Notable deps: ${(surface.dependencies || []).join('; ') || 'none identified'}

     Audit the code these point at, plus anywhere else your specialty applies.
     Report only findings with a concrete attack scenario naming who can trigger
     it and from where. Include a specific remediation per finding. Do not report
     hardening suggestions with no attack path. Empty findings is a valid result.`,
    { label: `sweep:${l.key}`, phase: 'Sweep', schema: FINDINGS_SCHEMA },
  ),

  // Stage 2: refutation panels, sized by claimed severity. Runs per-lens as
  // soon as that lens's sweep returns. Note phase comes via opts here — calling
  // the global phase() inside a pipeline stage would race with other items.
  (review, l) => parallel((review ? review.findings : []).map(f => () => {
    const n = PANEL_SIZE[f.severity] || 1
    return parallel(Array.from({ length: n }, (_, v) => () =>
      agent(
        `Skeptic ${v + 1}/${n}: REFUTE this security finding by reading the code.
         Claim: ${f.title} (${f.severity}) at ${f.file}${f.line ? ':' + f.line : ''}
         Evidence: ${f.evidence}
         Attack scenario: ${f.attackScenario}
         Check: is the input actually attacker-controlled? Is there sanitization,
         a framework guard, or an authz check upstream that the auditor missed? Is
         the "vulnerable" path reachable in production configuration? Default to
         refuted=true if the attack scenario cannot be shown to be reachable.`,
        { label: `refute:${l.key}:${v}`, phase: 'Refute', effort: 'high', schema: VERDICT_SCHEMA },
      ),
    )).then(verdicts => {
      const upheld = verdicts.filter(Boolean).filter(x => !x.refuted).length
      return { ...f, lens: l.key, upheld: `${upheld}/${n}`, survives: upheld >= Math.floor(n / 2) + 1 }
    })
  })),
)

const judged = results.filter(Boolean).flat().filter(Boolean)
const confirmed = judged.filter(f => f.survives)
const refuted = judged.filter(f => !f.survives)
log(`${confirmed.length} confirmed, ${refuted.length} refuted across ${lenses.length} lenses`)

// --------------------------------------------------------------------------
// Phase 4: Report.
// --------------------------------------------------------------------------

phase('Report')

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])

const report = confirmed.length === 0
  ? `Audited ${scope} across ${lenses.length} lenses over a mapped surface of ${surface.entryPoints.length} entry points. ${judged.length} candidate findings; none survived refutation.`
  : await agent(
      `Write a security-audit report in markdown.
       Surface summary: ${surface.summary}
       Confirmed findings (already refutation-tested): ${JSON.stringify(confirmed, null, 2)}
       For each: impact in one sentence, the attack scenario, and the remediation.
       Group by severity. Close with the top 3 systemic patterns you see across
       findings (e.g. "input validation is ad hoc at every boundary"). Return only
       markdown.`,
      { label: 'report', effort: 'low' },
    )

return {
  surface: surface.summary,
  confirmed,
  refuted: refuted.map(f => ({ title: f.title, lens: f.lens, upheld: f.upheld })),
  report,
}
