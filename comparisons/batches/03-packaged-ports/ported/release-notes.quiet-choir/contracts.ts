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

export const Kind = z.enum([
  'feature',
  'fix',
  'breaking',
  'performance',
  'deprecation',
  'internal',
]);
const change = {
  kind: Kind,
  summary: z.string().min(1),
  userVisible: z.boolean(),
  migrationNote: z.string().nullable(),
};
export const Change = z.object({ sha: Sha, ...change });
export type Change = z.infer<typeof Change>;

/** A slice summary may only name the slice's own commits, at most once each. */
export const SliceSummary = (shas: string[]) =>
  z.object({
    changes: z.array(z.object({ sha: z.enum(shas), ...change })).max(shas.length),
  });

export const ReleaseNotesInput = z.object({
  since: z.string().min(1).describe('Exclusive starting Git revision'),
  until: z.string().min(1).default('HEAD'),
  audience: z
    .string()
    .min(1)
    .default('developers using this project as a dependency')
    .describe('Who reads the notes; changes tone, selection and emphasis'),
  out: Path.default('RELEASE_NOTES.md'),
  publication: z
    .enum(['file', 'commit'])
    .default('file')
    .describe('Create a file, or publish a managed commit for lifecycle composition'),
  chunkSize: z.number().int().min(1).max(50).default(25),
  maxRevisions: z.number().int().min(0).max(2).default(1),
});

export const ReleaseNotesOutput = z.object({
  start: Sha,
  end: Sha,
  manifest: z.array(Sha),
  covered: z.array(Sha),
  missing: z.array(Sha),
  status: z.enum(['verified', 'needs-review']),
  factChecked: z.boolean(),
  notes: z.string(),
  breaking: z.array(Change),
  written: Receipt,
});
