# 0040: Grade harness versions against a tested range

- Status: accepted
- Issue: #143; amends [ADR 0011](0011-harness-controls-and-contracts.md) ("Only tested versions run
  exact-argv probes")
- Amended by #295: the Codex exact-argv probe sends a fresh nonexistent model as well as the invalid
  effort, and the Codex enums check can warn (see the residual-risk paragraph).

## Context

`configuration doctor` certified exactly one version per harness. After any Claude or Codex patch
release it failed the version check, and because that check failed it also skipped the exact-argv
probe, the one check that shows whether the new version still accepts quiet-choir's argv. The doctor
was red on most real machines while `workflow execute` ran the same untested version with no warning
at all.

## Decision

Move the tested-version policy into one pure module, `src/harnesses/tested-versions.ts`, read by the
doctor and by `NativeCliAdapter` (neither imports the other). `testedHarnessVersions` stays exported
and keeps its meaning: the range `npm run test:contract` verified.

- **Grading.** `gradeHarnessVersion(version, bounds)` returns `pass`, `warn` or `fail`. Pass means
  an exact digits-only `MAJOR.MINOR.PATCH` inside `[minimum, maximum]`, compared numerically by
  component. Warn means outside the range but on the same major.minor as a bound (an untested
  patch). Everything else fails: another major.minor, a missing or unparseable version, and any
  prerelease or build suffix. A nonzero exit, a signal, or process/stderr warnings from `--version`
  also fail. No semver dependency is added.
- **Always probe.** The exact-argv probe runs whenever `--version` answered, whatever the grade. Its
  pass or fail is reported independently. If the binary never answered (missing executable, timeout,
  cancellation) the probe is skipped with an explicit message and `zeroInference` stays false.
- **Report shape.** `DoctorCheck.status` is `pass`, `warn` or `fail`, and `ok` is
  `status !== 'fail'`. Only the version check can warn (amended by #295: the Codex enums check also
  warns when the server rejected the sentinel model before validating effort). `DoctorReport` gains
  `warnings` (one `<harness> <check>: <message>` per warning) and `verdict`: `blocked` when any
  check fails, `usable-with-warnings` when any warns, otherwise `ok`; `ok` is
  `verdict !== 'blocked'`. The `--workflow` registry path reports the same fields with pass/fail
  checks only.
- **`--strict`.** `DoctorOptions.strict` and `--strict` promote a version warning (and, since #295,
  the Codex unverified-effort warning) to `fail`, so `ok` stays `status !== 'fail'` with no
  exception, and the message says why.
- **CLI.** Text output prefixes each check with `PASS`, `WARN` or `FAIL` and ends with a verdict
  line naming the next command (for an untested patch, `npm run build && npm run test:contract` from
  a checkout, then widen `testedHarnessVersions`). Exit 1 only when the verdict is `blocked`.
- **Run time.** When `CliHarness` discovers a version outside the tested range it adds one
  deterministic `harnessWarnings` entry naming `quiet-choir configuration doctor --harness <name>`.
  The text has no timestamps, so the runner's set deduplicates it across the calls and resumes of a
  run. No warning is added when discovery failed; the existing discovery warning covers that.
- **Widening the range.** Raising `maximum` (or lowering `minimum`) still requires
  `npm run test:contract` evidence for that version. The warning exists so an operator can see the
  gap, not to replace that step.

## Consequences

The doctor is usable on a patched CLI and tells the operator exactly what is unverified, and a run
on an untested version is no longer silent. CI and scripts that treated any warning as a failure
need `--strict`. `DoctorCheck`, `DoctorReport` and `DoctorOptions` gain members at 0.0.0; code that
builds a `DoctorReport` by hand must supply `status`, `warnings` and `verdict`.

Residual risk: probing an untested CLI is no longer gated. The Claude probe caps spend with
`maxBudgetUsd: 0.01` and a nonexistent model. Codex has no per-request cost cap: codex-cli 0.160.0
rejects the candidate keys (`model_max_output_tokens`, `rollout_budget.limit_tokens`) under
`--strict-config`, and its Responses requests carry no `max_output_tokens`. So since #295 the Codex
probe sends a fresh nonexistent model, `quiet-choir-nonexistent-<uuid>`, through the adapter's real
`--model` option as well as `model_reasoning_effort="bogus"`, and asserts before spawning that the
argv carries it. A request for a model that does not exist cannot run inference whichever of the two
the server checks first, even on a CLI that stopped rejecting the bad effort. The argv check accepts
either rejection: the 400 that lists the supported efforts, or a 400 or 404 that names the exact
sentinel (codex-cli 0.160.0 prints a 404 as `unexpected status 404 Not Found: ...`). After a model
rejection there is no effort list, so the Codex enums check reports `warn` (enum drift unverified,
nothing spent) and `--strict` fails it. `zeroInference` is still judged after the call from the
observed output. The remaining exposure is a CLI that silently substitutes a known model for the
unknown one; `npm run test:contract:doctor` runs the installed Codex against a loopback fake API and
fails unless every request carries the sentinel model and the bogus effort, so run it before
widening the Codex range. This is accepted in exchange for a doctor that is not red on every patch
release.
