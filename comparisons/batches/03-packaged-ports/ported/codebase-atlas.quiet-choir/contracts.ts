// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});

export const Importance = z.enum(['core', 'supporting', 'peripheral']);
export type Importance = z.infer<typeof Importance>;

/** The survey: agents name paths loosely, so code normalizes and matches them to tracked files. */
export const Survey = z.object({
  projectSummary: z.string().min(1).describe('3-5 sentences: what this software is and does'),
  subsystems: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe('Repository-relative files or directories from the layout; no globs'),
        importance: Importance,
        hint: z.string().nullable().describe('One line on what this subsystem seems to do'),
      }),
    )
    .max(40),
});
export type Surveyed = z.infer<typeof Survey>['subsystems'][number];

/** A deep reader's card; the workflow attaches the section name, so the card does not carry it. */
export const Card = z.object({
  purpose: z.string().min(1).describe('2-4 sentences, written for a new team member'),
  keyFiles: z
    .array(
      z.object({
        path: z.string().min(1).describe('Repository-relative path of a tracked file'),
        role: z.string().min(1),
      }),
    )
    .min(1)
    .max(15),
  entryPoints: z.array(z.string().min(1)).max(10).describe('Where execution enters this subsystem'),
  dependsOn: z
    .array(z.string().min(1))
    .max(15)
    .describe('Other subsystems by their listed names, or external services'),
  dataFlows: z.string().nullable().describe('How data moves through it, one short paragraph'),
  gotchas: z
    .array(z.string().min(1))
    .max(12)
    .describe('Surprises: non-obvious invariants, footguns, historical scars'),
});
export type Card = z.infer<typeof Card>;

/** The synthesis may only point a newcomer at key files the cards cite and code verified. */
export const Synthesis = (keyFiles: readonly string[]) =>
  z.object({
    overview: z
      .string()
      .min(1)
      .describe('What this is: the project summary, sharpened, and how the subsystems fit'),
    startHere: keyFiles.length
      ? z
          .array(
            z.object({ path: z.enum(keyFiles as [string, ...string[]]), why: z.string().min(1) }),
          )
          .min(1)
          .max(3)
      : z.array(z.object({ path: z.string(), why: z.string() })).max(0),
  });
export type Synthesis = z.infer<ReturnType<typeof Synthesis>>;

/** The critic lists gaps; the atlas is complete exactly when it lists none (lib/policy.ts). */
export const Critique = z.object({
  gaps: z
    .array(
      z.object({
        section: z
          .string()
          .min(1)
          .max(80)
          .describe('An existing section name exactly, or the name of a section to add'),
        description: z.string().min(1),
        repairAction: z
          .string()
          .min(1)
          .describe('A concrete instruction a reader agent could execute'),
      }),
    )
    .max(12),
  verdict: z.string().min(1).describe('One line'),
});
export type Gap = z.infer<typeof Critique>['gaps'][number];

export const CodebaseAtlasInput = z.object({
  out: Path.default('docs/atlas.md').describe('Repository-relative path of the generated atlas'),
  maxSubsystems: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(8)
    .describe('Deep-read cap; core subsystems win slots, and the rest are listed as skipped'),
  maxRepairs: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(3)
    .describe('Sections the single repair round may correct or add'),
  replace: z
    .boolean()
    .default(false)
    .describe('Regenerate over an existing atlas at out; refused when it exists otherwise'),
});

const Section = z.object({ section: z.string(), gaps: z.number().int().min(1) });
export const CodebaseAtlasOutput = z.object({
  status: z.enum(['complete', 'repaired', 'limited', 'degraded', 'empty', 'refused']),
  commit: Sha,
  dirty: z.boolean().describe('Tracked files had uncommitted changes the readers may have seen'),
  atlasPath: Path.nullable(),
  written: Receipt.nullable(),
  atlas: z.string().nullable(),
  projectSummary: z.string().nullable(),
  subsystems: z.array(
    z.object({
      name: z.string(),
      importance: Importance.nullable(),
      purpose: z.string(),
      origin: z.enum(['read', 'repaired', 'added']),
    }),
  ),
  skipped: z.array(z.string()).describe('Surveyed subsystems past maxSubsystems, never deep-read'),
  unmatched: z.array(z.string()).describe('Surveyed subsystems whose paths match no tracked file'),
  unread: z.array(z.string()).describe('Subsystems whose deep reader failed'),
  uncovered: z
    .array(z.object({ area: z.string(), files: z.number().int().min(1) }))
    .describe('Tracked files no surveyed subsystem covers, by top-level entry'),
  droppedPaths: z
    .array(z.object({ section: z.string(), path: z.string() }))
    .describe('Cited files that are not tracked at the commit; left out of the atlas'),
  critique: z.string(),
  repairs: z.array(Section.extend({ outcome: z.enum(['repaired', 'added', 'failed']) })),
  unrepaired: z.array(Section).describe('Gap sections past maxRepairs'),
});
export type CodebaseAtlasOutput = z.infer<typeof CodebaseAtlasOutput>;
