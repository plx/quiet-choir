import { statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { PackageSelection } from '../loader/model.js';
import type { TypecheckPlan } from '../typecheck/model.js';
import { analyzeTypecheckEntrypoint } from '../typecheck/plan.js';

// ADR 0065 sections 1-2: a `*.quiet-choir` directory is a package whose `package.ts` manifest is
// the typecheck entrypoint. The analysis below is plain data (ADR 0001); the loader resolves the
// selected workflow's own module only after it imports the manifest.

/** The manifest file name of every package. @internal */
export const PACKAGE_MANIFEST = 'package.ts';

/** Manifest spellings that are refused, because manifests are TypeScript `package.ts` files. */
const refusedManifests = ['package.mts', 'package.cts', 'package.js', 'package.mjs', 'package.cjs'];

/**
 * Whether a path names a `*.quiet-choir` package directory: its last segment ends in
 * `.quiet-choir`, ignoring trailing separators. Reads nothing. @internal
 */
export function isPackagePath(path: string): boolean {
  return /\.quiet-choir$/iu.test(path.replace(/[\\/]+$/u, ''));
}

/** The plain-data result of {@link analyzePackagePath}. @internal */
export type PackagePathAnalysis =
  | {
      readonly ok: true;
      /** The typecheck plan of the manifest, with the nearest-tsconfig rule. */
      readonly typecheck: TypecheckPlan;
      /** The package selection without a workflow name, which the command adds. */
      readonly package: Omit<PackageSelection, 'workflow'>;
    }
  | {
      readonly ok: false;
      readonly error: {
        /**
         * `PACKAGE_NOT_FOUND` when nothing exists at the path, `PACKAGE_NOT_DIRECTORY` for a file,
         * `PACKAGE_MANIFEST_MISSING` for a directory without `package.ts`, and
         * `JAVASCRIPT_PACKAGE_MANIFEST` for one with only another manifest spelling.
         */
        readonly code:
          | 'PACKAGE_NOT_FOUND'
          | 'PACKAGE_NOT_DIRECTORY'
          | 'PACKAGE_MANIFEST_MISSING'
          | 'JAVASCRIPT_PACKAGE_MANIFEST';
        readonly message: string;
        /** The absolute path the error is about. */
        readonly path: string;
      };
    };

function kind(path: string): 'file' | 'directory' | 'other' | null {
  try {
    const found = statSync(path);
    return found.isDirectory() ? 'directory' : found.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/**
 * Analyze a `*.quiet-choir` path into the manifest's typecheck plan and the package selection, or
 * a coded error: a missing path or manifest, a path that is not a directory, or a directory whose
 * manifest is JavaScript (or `.mts`/`.cts`) instead of `package.ts`. @internal
 */
export function analyzePackagePath(inputPath: string, cwd: string): PackagePathAnalysis {
  const root = resolve(cwd, inputPath);
  const found = kind(root);
  if (found === null)
    return {
      ok: false,
      error: {
        code: 'PACKAGE_NOT_FOUND',
        message: `No package directory found at ${inputPath}`,
        path: root,
      },
    };
  if (found !== 'directory')
    return {
      ok: false,
      error: {
        code: 'PACKAGE_NOT_DIRECTORY',
        message: `A .quiet-choir package must be a directory with a package.ts manifest: ${inputPath}`,
        path: root,
      },
    };
  const manifest = join(root, PACKAGE_MANIFEST);
  if (kind(manifest) !== 'file') {
    const other = refusedManifests.find((name) => kind(join(root, name)) === 'file');
    return other === undefined
      ? {
          ok: false,
          error: {
            code: 'PACKAGE_MANIFEST_MISSING',
            message: `No package.ts manifest found in package ${inputPath}`,
            path: manifest,
          },
        }
      : {
          ok: false,
          error: {
            code: 'JAVASCRIPT_PACKAGE_MANIFEST',
            message: `Package ${inputPath} has ${other} but no package.ts: a package manifest is the TypeScript file package.ts (ADR 0065); rename ${other} to package.ts.`,
            path: join(root, other),
          },
        };
  }
  const analysis = analyzeTypecheckEntrypoint(manifest, cwd);
  if (!analysis.ok) throw new Error(`Unreachable: ${basename(manifest)} is a TypeScript source.`);
  return {
    ok: true,
    typecheck: analysis.plan,
    package: { kind: 'workflow.package', root, manifest },
  };
}
