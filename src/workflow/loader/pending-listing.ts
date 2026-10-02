import type { CommandLauncher } from '../runtime/commands.js';
import type { RunRecord } from '../runtime/store.js';
import type { PendingListing } from '../runtime/wait-model.js';
import { queuedNextCommands, type NextCommand } from './next-commands.js';

/** One run's waiting rows, as `listPendingRuns` groups them. @internal */
export interface PendingGroup {
  readonly run: RunRecord;
  readonly pending: readonly PendingListing[];
}

/** A listed row with its follow-up commands, empty when none applies. @internal */
export type PendingRow = PendingListing & { readonly next: readonly NextCommand[] };

/** What the CLI shows and how many rows the default filter left out. @internal */
export interface PendingSelection {
  readonly pending: PendingRow[];
  readonly hidden: number;
}

/**
 * Choose the rows `workflow pending` lists. By default a row is hidden when its run is failed,
 * cancelled or completed (nothing will answer it) or when an answer is already queued for it (the
 * owner consumes it on its next resume or tick). Running and suspended rows stay, so a
 * `--wait-mode block` run's live question is listed. `all` keeps every row.
 *
 * Every row carries `next`: a queued row of a suspended or failed run with launch metadata gets
 * one resume entry; every other row gets none, because a running owner ingests the answer itself
 * and a resume would only hit `run.locked`. Pure: no I/O. @internal
 */
export function selectPendingRows(
  groups: readonly PendingGroup[],
  options: {
    readonly all: boolean;
    readonly stateDir: string;
    readonly launcher?: CommandLauncher | undefined;
  },
): PendingSelection {
  const pending: PendingRow[] = [];
  let hidden = 0;
  for (const { run, pending: rows } of groups) {
    for (const row of rows) {
      const queued = row.delivery?.state === 'queued';
      const ended =
        row.runStatus === 'failed' ||
        row.runStatus === 'cancelled' ||
        row.runStatus === 'completed';
      if (!options.all && (queued || ended)) {
        hidden += 1;
        continue;
      }
      pending.push({
        ...row,
        next:
          queued && (row.runStatus === 'suspended' || row.runStatus === 'failed')
            ? queuedNextCommands(run, options.stateDir, options.launcher)
            : [],
      });
    }
  }
  return { pending, hidden };
}
