const pattern = '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$';
const valid = new RegExp(pattern, 'u');

/** Validate a leaf ID with a bounded display and the exact offending character/position. @internal */
export function validateStepId(id: string): void {
  if (valid.test(id)) return;
  const display = JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id);
  let index = 0;
  let invalid: string | undefined;
  for (const character of id) {
    if (index >= 200 || !(index === 0 ? /^[a-zA-Z0-9]$/u : /^[a-zA-Z0-9._:/-]$/u).test(character)) {
      invalid = character;
      break;
    }
    index += character.length;
  }
  throw new Error(
    `Invalid step ID ${display}: must match ${pattern} (${invalid === undefined ? 'missing first character' : `first invalid character ${JSON.stringify(invalid)}`} at index ${String(index)}).`,
  );
}
