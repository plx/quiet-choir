import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { InstructionSource } from '../harness-kit.js';
import { Collector, kindOf, maxSkills, SkillBudget, userHomeOf } from './instruction-files.js';

/*
 * Discovery rules measured against codex-cli 0.157.1 (2026-10-05) and re-measured on 0.160.0
 * (2026-10-06, which added the skill roots and memories below) with the zero-cost fake-API probe in
 * test/harness-isolation-contract.mjs. Restricted calls pass --ignore-user-config, which skips
 * config.toml, so only Codex's built-in defaults apply:
 *
 * - User level: CODEX_HOME/AGENTS.override.md if present, otherwise CODEX_HOME/AGENTS.md.
 * - User skills: SKILL.md files under CODEX_HOME/skills and under $HOME/.agents/skills (the child's
 *   HOME, which need not be an ancestor of cwd).
 * - Project level: from the nearest ancestor of cwd holding a .git entry (file or directory) down
 *   to cwd, each directory contributes AGENTS.override.md if present, otherwise AGENTS.md, and then
 *   the SKILL.md files under its .agents/skills. With no .git entry, only cwd is read. cwd alone
 *   also contributes the SKILL.md files under its .codex/skills; the same directory at the Git root
 *   or above it is not read.
 *
 * Skill roots are searched down to six directory levels below the root (a skill seven levels down
 * did not load), skipping names that start with a dot; Codex writes its own bundled skills to
 * skills/.system. A skill directory is itself searched, since a SKILL.md nested inside another
 * skill loads too. Measured by codex-restricted, codex-restricted-skill-layout and
 * codex-restricted-skill-no-git.
 *
 * Memories (CODEX_HOME/memories/memory_summary.md) do not load by default; they load only with
 * features.memories enabled (codex-restricted-memories-enabled), which needs explicit config or an
 * inherited config.toml. Like the other inherit-mode keys below, that is not modelled, so memories
 * are not detected.
 *
 * Blank means empty or whitespace-only, following Rust's str::trim (Unicode White_Space; a lone
 * U+FEFF is content). Measured by the contract cases codex-restricted-empty-override,
 * codex-restricted-whitespace-override, codex-restricted-whitespace-user-agents and
 * codex-restricted-whitespace-project-agents:
 *
 * - A blank user-level override counts as absent and falls back to AGENTS.md; a blank user-level
 *   AGENTS.md contributes nothing. Neither is recorded.
 * - A project-level override is selected by presence, so a blank one still replaces AGENTS.md in
 *   its directory. It is recorded because it explains why AGENTS.md was not loaded.
 * - A blank project-level AGENTS.md contributes nothing and is not recorded.
 *
 * BOM-only files and invalid UTF-8 were not probed; decoding is non-fatal, so they count as
 * content, which errs toward recording a source. Skill files are recorded whatever their content.
 * Inherit-mode config keys (project_root_markers, project_doc_fallback_filenames,
 * project_doc_max_bytes, features.memories) can change what Codex loads and are not modelled; this
 * is a diagnostic, never part of step identity.
 *
 * instructions: 'none' (a private CODEX_HOME plus project_doc_max_bytes=0) removes the CODEX_HOME
 * files and project AGENTS files only: the .agents and .codex skill roots still load
 * (codex-instructions-none).
 *
 * The two levels are detected separately: the runtime records user-level sources once per harness
 * registration per run invocation (through adapter metadata) and project-level sources once per
 * distinct working directory, isolation mode and env edits (through the adapter's
 * projectInstructions hook).
 */

/** Inputs for the Codex instruction detectors. @internal */
export interface CodexInstructionOptions {
  /** Resolved Codex configuration directory. */
  readonly codexHome: string;
  /** Working directory of the Codex call; project files are searched from here, and a relative codexHome resolves against it. */
  readonly cwd: string;
  /**
   * The child's home directory, holding the user-level `.agents/skills` root; defaults to the
   * current user's home. A relative value resolves against `cwd`.
   */
  readonly home?: string | undefined;
  /** Cancellation; an abort rejects instead of becoming a warning. */
  readonly signal?: AbortSignal | undefined;
}

/** Instruction sources found by one detection, as paths and digests only. @internal */
export interface CodexInstructionDetection {
  /** User sources first, then project sources from the Git root down to cwd. */
  readonly sources: readonly InstructionSource[];
  /** User-level skill files found beyond the listing cap, counted but not listed. */
  readonly omittedSkills: number;
  /** Read problems; detection never throws for them. */
  readonly warnings: readonly string[];
}

/** The Codex home a child with this environment resolves; empty values count as unset. @internal */
export function codexHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['CODEX_HOME'];
  if (configured) return configured;
  return join(userHomeOf(env), '.codex');
}

/** Record the AGENTS file Codex loads from one directory; the override replaces the plain file. */
async function agents(
  found: Collector,
  scope: InstructionSource['scope'],
  directory: string,
): Promise<void> {
  // Measured: a blank (empty or whitespace-only) user-level override is treated as absent and
  // falls back to AGENTS.md; a project-level override is selected by presence, so a blank one
  // still replaces AGENTS.md and is recorded. A blank AGENTS.md is never recorded.
  if (
    await found.add(
      scope,
      'agents-override',
      join(directory, 'AGENTS.override.md'),
      scope === 'user' ? 'skip' : 'record',
    )
  )
    return;
  await found.add(scope, 'agents', join(directory, 'AGENTS.md'), 'skip');
}

/**
 * Detect the user-level files Codex loads whatever the isolation mode: CODEX_HOME AGENTS files and
 * the skill files under CODEX_HOME/skills and $HOME/.agents/skills. `cwd` only resolves a relative
 * `codexHome` or `home`. @internal
 */
export async function detectCodexUserInstructionSources(
  options: CodexInstructionOptions,
): Promise<CodexInstructionDetection> {
  const found = new Collector('Codex', options.signal);
  const budget = new SkillBudget();
  const codexHome = resolve(options.cwd, options.codexHome);
  await agents(found, 'user', codexHome);
  await found.skills('user', join(codexHome, 'skills'), budget);
  await found.skills(
    'user',
    join(resolve(options.cwd, options.home ?? homedir()), '.agents', 'skills'),
    budget,
  );
  return { sources: found.sources, omittedSkills: budget.omitted, warnings: found.warnings };
}

/**
 * Detect the project-level files Codex loads for one working directory: from the Git root down to
 * `cwd`, each directory's AGENTS file and `.agents/skills` files, then cwd's `.codex/skills`
 * files. A directory equal to `home` is skipped for `.agents/skills`, which the user-level detector
 * reports. It never reads CODEX_HOME and spawns no process. @internal
 */
export async function detectCodexProjectInstructionSources(
  options: Pick<CodexInstructionOptions, 'cwd' | 'home' | 'signal'>,
): Promise<Pick<CodexInstructionDetection, 'sources' | 'warnings'>> {
  const { signal } = options;
  const found = new Collector('Codex', signal);
  const cwd = resolve(options.cwd);
  const home = resolve(cwd, options.home ?? homedir());
  const directories = [cwd];
  try {
    for (let current = cwd; ; current = dirname(current)) {
      signal?.throwIfAborted();
      if ((await kindOf(join(current, '.git'))) !== 'absent') {
        // Walk from the Git root down to cwd.
        directories.length = 0;
        for (let next = cwd; ; next = dirname(next)) {
          directories.unshift(next);
          if (next === current) break;
        }
        break;
      }
      if (dirname(current) === current) break;
    }
  } catch (error) {
    found.fail(join(cwd, '.git'), error);
  }
  const budget = new SkillBudget();
  for (const directory of directories) {
    await agents(found, 'project', directory);
    if (directory !== home)
      await found.skills('project', join(directory, '.agents', 'skills'), budget);
  }
  await found.skills('project', join(cwd, '.codex', 'skills'), budget);
  if (budget.omitted)
    found.warnings.push(
      `Codex loads ${String(budget.omitted)} more project skill file${budget.omitted === 1 ? '' : 's'} for ${cwd} than the ${String(maxSkills)} recorded.`,
    );
  return { sources: found.sources, warnings: found.warnings };
}

/**
 * Detect every instruction file Codex loads for one call whatever the isolation mode: the user
 * files, then the project files for `cwd`. `workflow doctor` reports this combined view; the
 * runtime records the two levels separately. @internal
 */
export async function detectCodexInstructionSources(
  options: CodexInstructionOptions,
): Promise<CodexInstructionDetection> {
  const user = await detectCodexUserInstructionSources(options);
  const project = await detectCodexProjectInstructionSources(options);
  return {
    sources: [...user.sources, ...project.sources],
    omittedSkills: user.omittedSkills,
    warnings: [...user.warnings, ...project.warnings],
  };
}

/** One run warning naming the user-level files Codex loads even in restricted mode. @internal */
export function codexInstructionWarning(detection: CodexInstructionDetection): string | undefined {
  const user = detection.sources.filter((source) => source.scope === 'user');
  const files = user.filter((source) => source.kind !== 'skill');
  const skills = user.filter((source) => source.kind === 'skill').length + detection.omittedSkills;
  if (!user.length && !detection.omittedSkills) return undefined;
  const parts = files.map((source) => `${source.path} (sha256 ${source.sha256.slice(0, 12)})`);
  if (skills) parts.push(`${String(skills)} skill description file${skills === 1 ? '' : 's'}`);
  return `Codex loads user-level instructions in every isolation mode, including restricted: ${parts.join(', ')}. Results can depend on who runs this workflow. Set codex instructions: 'none' to run a call without the CODEX_HOME files; skills under $HOME/.agents/skills still load.`;
}
