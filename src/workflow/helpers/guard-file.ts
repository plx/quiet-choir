import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowContext } from '../runtime/model.js';
import { guardProgram } from './guard-program.js';

/** Policy for a single durable guarded body. */
export interface GuardFileOptions {
  /** Restore silently by default, or restore and then fail if the body changed the file. */
  readonly onChange?: 'restore' | 'error';
  /** Maximum UTF-8 baseline/current bytes, default 1048576. */
  readonly maxBytes?: number;
  /** Revision for dependencies captured by the body but absent from its source. */
  readonly version?: string;
}

/**
 * Preserve an uncommitted UTF-8 Git blob and restore in code after one journaled body outcome.
 * The body must return JSON. Its success or ordinary failure is terminal for this guard ID.
 * No concurrent-writer protection or automatic restore before an interrupted body reruns.
 */
export function guardFile<T>(
  ctx: WorkflowContext,
  id: string,
  path: string,
  body: () => Promise<T>,
  options: GuardFileOptions = {},
): Promise<T> {
  return ctx.scope(id, async () => {
    const settings = z
      .strictObject({
        onChange: z.enum(['restore', 'error']).default('restore'),
        maxBytes: z.number().int().positive().max(2_147_482_623).default(1_048_576),
        version: z.string().min(1).optional(),
      })
      .parse(options);
    if (typeof body !== 'function') throw new Error('guardFile requires a body callback.');
    const baseline = await ctx.exec.json(
      'baseline',
      [
        process.execPath,
        '--input-type=module',
        '-e',
        guardProgram,
        'baseline',
        path,
        String(settings.maxBytes),
      ],
      {
        schema: z.object({
          path: z.string(),
          blob: z.string().min(1),
          mode: z.number().int().nonnegative(),
        }),
      },
    );
    const identity = createHash('sha256')
      .update(
        JSON.stringify({
          source: Function.prototype.toString.call(body),
          version: settings.version ?? null,
          onChange: settings.onChange,
        }),
      )
      .digest('hex');
    // A terminal body prevents a later resume from mutating again after restore has already replayed.
    const [outcome] = await ctx.map(
      'body',
      [{ path: baseline.path, blob: baseline.blob, identity }],
      { concurrency: 1, onError: 'settle' },
      () => body(),
    );
    if (!outcome) throw new Error('Guard body outcome is missing.');
    const restored = await ctx.exec.json(
      'restore',
      [
        process.execPath,
        '--input-type=module',
        '-e',
        guardProgram,
        'restore',
        baseline.path,
        String(settings.maxBytes),
        baseline.blob,
        String(baseline.mode),
      ],
      {
        schema: z.object({ changed: z.boolean() }),
      },
    );
    if (!outcome.ok) throw new Error(`Guarded body failed: ${outcome.error.message}`);
    if (restored.changed && settings.onChange === 'error')
      throw new Error(`Guarded file changed and was restored: ${baseline.path}`);
    return outcome.value;
  });
}
