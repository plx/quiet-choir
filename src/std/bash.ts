/**
 * `Bash(...)` permission rules for shell-capable Claude entries (`std.claude.shell` and
 * `std.claude.editShell`). Each rule is a Claude Code prefix rule, `Bash(<command>:*)`, which
 * approves the command with any arguments; the sets below are frozen arrays to spread into one
 * allowlist. The rule strings match the ones the bundled package rosters spell by hand, so an entry
 * built from them is the same configuration as that list in the same order.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Checker: {
 *     ...std.claude.shell([...std.bash.gitRead, ...std.bash.npmRun('lint', 'test')]),
 *     ...std.tiers.Mechanic,
 *     ...std.personas.Tester,
 *   },
 * });
 * ```
 *
 * A prefix rule approves every argument list, including flags that write: `npx prettier` also
 * approves `npx prettier --write`, and `npx eslint` approves `--fix`. Pick the sets an entry's
 * role needs, and keep editing roles separate from checking ones. Deny rules ({@link noPush},
 * {@link noRewrite}) are prefix rules too: they take precedence over the allowlist but cannot
 * catch a reordered command such as `git commit -a --amend`; the allowlist is the real boundary.
 *
 * @module
 */

/**
 * What a rule word cannot contain: parentheses, which end the rule, `*`, which would make it a
 * wildcard pattern, and control characters (C0, DEL and C1).
 */
const forbidden = /[()*\p{Cc}]/u;

/** Check one command word of a rule. */
function checkWord(where: string, word: unknown): string {
  if (
    typeof word !== 'string' ||
    word.trim() === '' ||
    word !== word.trim() ||
    forbidden.test(word)
  )
    throw new TypeError(
      `${where}: ${JSON.stringify(word)} must be a nonempty command word without surrounding whitespace, parentheses, asterisks or control characters.`,
    );
  return word;
}

/**
 * Build one `Bash(...)` prefix rule from command words: `rule('git', 'log')` is
 * `'Bash(git log:*)'`, which approves `git log` with any arguments.
 *
 * @param words - The command and the leading arguments the rule fixes, such as
 *   `'gh', 'pr', 'view'`.
 * @returns The rule, `Bash(<words joined by spaces>:*)`.
 * @throws TypeError - A word is empty, has surrounding whitespace, or contains a parenthesis, an
 *   asterisk or a control character.
 */
export function rule(...words: [string, ...string[]]): string {
  if (words.length === 0) throw new TypeError('std.bash.rule needs at least one command word.');
  return `Bash(${words.map((word) => checkWord('std.bash.rule', word)).join(' ')}:*)`;
}

/** Freeze a list of rules built from command lines. */
function rules(...commands: readonly string[]): readonly string[] {
  return Object.freeze(commands.map((command) => `Bash(${command}:*)`));
}

/**
 * Read-only Git inspection: `git log`, `diff`, `show`, `status`, `rev-parse`, `blame`, `ls-files`
 * and `grep`.
 */
export const gitRead: readonly string[] = rules(
  'git log',
  'git diff',
  'git show',
  'git status',
  'git rev-parse',
  'git blame',
  'git ls-files',
  'git grep',
);

/**
 * Read-only GitHub CLI calls: `gh issue view`, `gh issue list`, `gh pr view`, `gh pr list`,
 * `gh pr checks`, `gh pr diff` and `gh run view`. They need the `gh` CLI signed in and network
 * access to GitHub.
 */
export const ghRead: readonly string[] = rules(
  'gh issue view',
  'gh issue list',
  'gh pr view',
  'gh pr list',
  'gh pr checks',
  'gh pr diff',
  'gh run view',
);

/** Directory listings and counts: `ls` and `wc`. */
export const files: readonly string[] = rules('ls', 'wc');

/**
 * Node.js checks through local binaries: `npx tsc`, `npx eslint`, `npx prettier`, `npx vitest` and
 * `node --test`. `npx prettier --write` and `npx eslint --fix` match too.
 */
export const nodeCheck: readonly string[] = rules(
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'npx vitest',
  'node --test',
);

/**
 * Rules for named npm scripts: `npmRun('build', 'lint')` is
 * `['Bash(npm run build:*)', 'Bash(npm run lint:*)']`. A script runs whatever `package.json`
 * says, so allow only scripts whose definition the role may run.
 *
 * @param scripts - Script names as `package.json` lists them, such as `typecheck` or
 *   `packages:rehearse`.
 * @returns A frozen list with one rule per script, in order.
 * @throws TypeError - A script name is empty, has surrounding whitespace, or contains a
 *   parenthesis, an asterisk or a control character.
 */
export function npmRun(...scripts: [string, ...string[]]): readonly string[] {
  if (scripts.length === 0) throw new TypeError('std.bash.npmRun needs at least one script name.');
  return rules(...scripts.map((script) => `npm run ${checkWord('std.bash.npmRun', script)}`));
}

/**
 * Python checks: `pytest`, `python -m pytest`, `python3 -m pytest`, `ruff` and `mypy`.
 * `ruff format` and `ruff check --fix` match too.
 */
export const pythonCheck: readonly string[] = rules(
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'ruff',
  'mypy',
);

/** Rust checks: `cargo check`, `cargo test`, `cargo clippy` and `cargo fmt`. */
export const cargoCheck: readonly string[] = rules(
  'cargo check',
  'cargo test',
  'cargo clippy',
  'cargo fmt',
);

/** Go checks: `go build`, `go test`, `go vet` and `gofmt`. */
export const goCheck: readonly string[] = rules('go build', 'go test', 'go vet', 'gofmt');

/** Local commits: `git add`, `git commit`, `git rm` and `git mv`; nothing that publishes. */
export const gitCommit: readonly string[] = rules('git add', 'git commit', 'git rm', 'git mv');

/**
 * Conflict resolution during a rebase: `git checkout --ours`, `git checkout --theirs` and
 * `git -c core.editor=true rebase --continue` (which continues without opening an editor). A plain
 * `git checkout` and `git rebase` stay unapproved.
 */
export const gitRebase: readonly string[] = rules(
  'git checkout --ours',
  'git checkout --theirs',
  'git -c core.editor=true rebase --continue',
);

/** Dependency installation: `npm ci` and `npm install`, which run package install scripts. */
export const npmInstall: readonly string[] = rules('npm ci', 'npm install');

/** A deny list that forbids `git push`: the default `disallowedTools` of the std shells. */
export const noPush: readonly string[] = rules('git push');

/**
 * A deny list that forbids publishing and rewriting or discarding history and work: `git push`,
 * `git reset`, `git rebase`, `git clean`, `git restore`, `git stash`, `git commit --amend`,
 * `git branch -D`, `git branch -f`, `git filter-branch` and `git update-ref`. It shadows no whole
 * rule of the sets in this module (it narrows `git commit` only by `--amend`), so it combines with
 * {@link gitCommit} and {@link gitRebase}.
 */
export const noRewrite: readonly string[] = rules(
  'git push',
  'git reset',
  'git rebase',
  'git clean',
  'git restore',
  'git stash',
  'git commit --amend',
  'git branch -D',
  'git branch -f',
  'git filter-branch',
  'git update-ref',
);
