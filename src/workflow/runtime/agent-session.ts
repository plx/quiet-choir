import { createHash } from 'node:crypto';
import { validateStepId } from './identity.js';

/** Derive the requested Claude UUID from a run's stored salt, full step ID and attempt number. */
export function deriveAgentSessionId(salt: string, stepId: string, attempt: number): string {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(salt))
    throw new Error('Session salt must be a UUID.');
  validateStepId(stepId);
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('Session attempt must be a positive safe integer.');
  const bytes = createHash('sha1')
    .update(Buffer.from(salt.replaceAll('-', ''), 'hex'))
    .update(`${stepId}/${String(attempt)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x50;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
