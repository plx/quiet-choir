import { readFileSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runCancelRequestPath, runLockPath } from './paths.js';
import { atomicStorageWrite } from './storage-io.js';

/**
 * A `workflow cancel` request, bound to the lock token of the one execution it targets. Every lock
 * acquisition draws a fresh token, so a request left over from an earlier execution never matches a
 * later one, in the same process or another (ADR 0039).
 */
const cancelRequestSchema = z.object({
  version: z.literal(1),
  /** Identifies this request, so its writer removes only its own file. */
  requestId: z.string().min(1),
  /** The targeted owner's lock token, read from its `owner.json`. */
  token: z.string().min(1),
  pid: z.number().int().positive(),
  host: z.string(),
  osStartTime: z.string(),
  requestedAt: z.string(),
});

/** A stored cancel request. @internal */
export type CancelRequest = z.infer<typeof cancelRequestSchema>;

/** Only the owner fields the match needs; the lock module owns the full schema. */
const ownerTokenSchema = z.object({ pid: z.number().int().positive(), token: z.string() });

/** Atomically replace the run's cancel request and return its path. @internal */
export async function writeCancelRequest(
  stateDir: string,
  runId: string,
  request: CancelRequest,
): Promise<string> {
  const path = runCancelRequestPath(stateDir, runId);
  await atomicStorageWrite(path, `${JSON.stringify(cancelRequestSchema.parse(request))}\n`);
  return path;
}

/**
 * Remove the request at `path` only while it is still the one with `requestId`; best effort, since a
 * leftover request can never match a later execution. @internal
 */
export async function removeCancelRequest(path: string, requestId: string): Promise<void> {
  try {
    const current = cancelRequestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (current.requestId === requestId) await rm(path, { force: true });
  } catch {
    /* Missing, replaced or unreadable: nothing of ours to remove. */
  }
}

/**
 * The cancel request aimed at this process's current ownership of the run, if any. It matches only
 * when the request's token is the token in the run's current `owner.json` and both name this
 * process. Reads are synchronous, so an abort listener can decide before the abort propagates; any
 * read or parse failure means no request. @internal
 */
export function matchingCancelRequestSync(
  stateDir: string,
  runId: string,
): { readonly requestedAt: string } | undefined {
  try {
    const request = cancelRequestSchema.parse(
      JSON.parse(readFileSync(runCancelRequestPath(stateDir, runId), 'utf8')),
    );
    const owner = ownerTokenSchema.parse(
      JSON.parse(readFileSync(join(runLockPath(stateDir, runId), 'owner.json'), 'utf8')),
    );
    return request.token === owner.token && owner.pid === process.pid && request.pid === process.pid
      ? { requestedAt: request.requestedAt }
      : undefined;
  } catch {
    return undefined;
  }
}
