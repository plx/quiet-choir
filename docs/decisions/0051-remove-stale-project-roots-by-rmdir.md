# 0051: Remove stale project roots by rmdir only

- Status: accepted
- Issue: #366 (split from #166, retention)
- Builds on: [0050](0050-select-runs-for-prune-conservatively.md) (prune selection),
  [0049](0049-guard-held-run-removal.md) (guarded `workflow rm`) and
  [0032](0032-interprocess-worktree-administration-lock.md) (worktree administration lock)

## Context

Every default runs container lives in an XDG project root,
`${XDG_STATE_HOME:-~/.local/state}/quiet-choir/<project>-<hash>/`, registered by its `project.json`.
`workflow prune --missing-cwd --all` (ADR 0050) removes the runs of deleted workspaces, but their
roots stay, and `workflow list --all` keeps scanning them. Other roots have no `project.json` at
all: the default worktree cache root is keyed by repository (`defaultWorktreeRoot(repo)` is
`<repo's project root>/worktrees`), so a run with an explicit `--state-dir`, or one started in a
project subdirectory, creates `worktrees/<runId>-<namespace>/` in a root that nothing registers.
`list --all` warns `Skipped project <root>: ...` for each one, forever.

Such a root can still be in use. A live run with an explicit `--state-dir` in another directory may
be creating a cache under the root's `worktrees/` right now, and prune cannot see that run: it scans
registered projects only. Git administration does not help either: the repository may be gone, and
the ADR 0032 lock serializes `git worktree` commands, not directory creation.

## Decision

Root cleanup is a second phase of `pruneRuns`, run only when both `--missing-cwd` and `--all` are
given and only after every run removal; without both, `roots` is empty and no root is touched.

**Which roots.** Discovery is `list --all`'s own: `projectRoots()` in `paths.ts` lists every real
directory (no symbolic links) under the XDG `quiet-choir` directory with its registration or the
reason it has none, and `projectStateDirectories` is rebuilt on it with byte-identical output. A
root is stale when its recorded cwd is missing (stat fails with `ENOENT` or `ENOTDIR`, the same rule
as the run filter; any other error is a warning and the root is skipped) or when it has no readable,
valid `project.json`. The current project's root and roots whose cwd exists are never considered.

**A pure decision.** `rootDecision` in `src/workflow/loader/root-selection.ts` (ESLint purity block)
keeps a stale root, first match wins, when a run listed in its `runs/` stays (`runs-kept`:
protected, refused or not selected), when a `worktrees/<runId>-<namespace>/` directory names a run
that some scanned container still holds (`in-use`), or when the walk found any entry outside the
bare layout (`files`). The bare layout of a registered root is `project.json`, `runs/`,
`runs/.gitignore`, `worktrees/` and directories below `worktrees/`; of an unregistered root, only
`worktrees/` and directories below it, or nothing. Otherwise the root is removed as `missing-cwd` or
`empty`. The orchestrator in `prune-roots.ts` walks with `lstat` semantics, never following a
symbolic link, skips the subtrees of the runs, caches and tombstones the run phase removed (or, in a
dry run, would remove), so the dry run predicts the real prune, and stops after 20 blocking entries.
It never walks a `runs-kept` or `in-use` root, so a large live cache is never crawled.

**Unlink two files, rmdir the rest.** A real removal unlinks `runs/.gitignore` and rmdirs `runs/`,
rmdirs the `worktrees/` tree bottom-up, unlinks `project.json` and rmdirs the root. Nothing else is
ever unlinked, and there is no recursive or forced delete. An `rmdir` of an empty directory is
atomic, so a cache created concurrently makes it fail with `ENOTEMPTY`; prune then puts back the
file it unlinked just before (`runs/.gitignore`, or `project.json` with its original bytes and mode,
created exclusively) and reports the root `busy`. A registered root therefore keeps its
`project.json` until the final `rmdir` succeeds, and never turns into a `Skipped project` root. A
restore that fails is a warning naming the root. `ENOENT` counts as done; any other error reports
the root as `storage`, and one root's failure never stops the batch. The signal is checked before
each root, and an interrupted prune reports the roots removed so far in `error.details.roots`.

**No lock.** Nothing here is Git administration, and an `rmdir` race is already safe, so prune takes
no lock for roots. Unregistered roots are removed even when their repository still exists: they hold
only empty directories, which `mkdir -p` and `git worktree add` recreate on demand.

**Result.** `PruneResult` gains `roots[]`, sorted by root, with
`{root, cwd, registered, removed, reason, bytes, paths, runs, message}`. `bytes` is the size of the
two unlinked files for a removed root and null for a kept one, which is never measured; the
top-level `bytes` keeps its meaning, the sum of `removed[].bytes`. The text output keeps its first
line and adds a root summary line and one line per root.

## Consequences

- `prune --missing-cwd --all` leaves no phantom runs and no `Skipped project` warnings for roots
  that held only registration data and empty directories; anything else is reported with up to 20
  blocking paths for the operator to judge. A macOS `.DS_Store` keeps a root, which is conservative.
- A run in an unscanned explicit `--state-dir` is protected only by the `rmdir` race. In the narrow
  window between `mkdir(requestedRoot)` and `realpath` in worktree isolation, a removed root can
  make one cache initialization fail with `ENOENT`; that attempt fails retryably, and no cache is
  lost. A grace period was rejected as it would only shrink, not close, that window.
- Roots with any other file, roots of existing workspaces and roots without both flags stay
  untouched; automatic or scheduled pruning remains out of scope.
