import { z } from 'zod';

import { agentDiagnosticsSchema } from './agent-stream-schema.js';
import { usageIdentitySchema } from './usage.js';
import { worktreeChangeSchema } from './worktree-schema.js';

/** Declared once so the exported return type is the shape zod infers, not a hand copy. */
const resultSchema = <T extends z.ZodType>(output: T) =>
  z.object({
    diagnostics: agentDiagnosticsSchema,
    output,
    sessionId: z.string().nullable(),
    usage: usageIdentitySchema,
  });
type Result<T extends z.ZodType> = ReturnType<typeof resultSchema<T>>;
const isolatedSchema = <T extends z.ZodType>(output: T) =>
  resultSchema(output).extend({ worktree: worktreeChangeSchema });
type Isolated<T extends z.ZodType> = ReturnType<typeof isolatedSchema<T>>;

/**
 * The agent result wrapper whose JSON Schema enters agent identity. Key order and construction are
 * part of that identity: changing either strands completed agent steps (ADR 0005, ADR 0006).
 * `test/schema-identity.test.ts` pins its encoding. @internal
 */
export function agentResultIdentitySchema<T extends z.ZodType>(
  output: T,
  isolated: boolean,
): Result<T> | Isolated<T> {
  return isolated ? isolatedSchema(output) : resultSchema(output);
}

const legacyResultSchema = <T extends z.ZodType>(output: T) =>
  z.object({ output, sessionId: z.string().nullable(), usage: usageIdentitySchema });
type LegacyResult<T extends z.ZodType> = ReturnType<typeof legacyResultSchema<T>>;

/**
 * The frozen agent result wrapper that original format-one hashed into an agent step's
 * fingerprint, used only to verify a legacy agent step during migration. It predates diagnostics
 * and worktree isolation. Key order and construction are that identity: never edit it, or every
 * unfinished format-one agent step is refused instead of migrated. `test/fixtures/storage/v1.json`
 * pins it. @internal
 */
export function legacyAgentResultSchema<T extends z.ZodType>(output: T): LegacyResult<T> {
  return legacyResultSchema(output);
}
