import { z } from 'zod';

/** Loose JSON keys keep future diagnostic additions outside replay schema identity. @internal */
export const agentDiagnosticsSchema = z.record(z.string(), z.json());
/** Private transcript receipt without raw content. @internal */
export const agentTranscriptSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  retained: z.boolean(),
});
