// Shared deterministic reply generator for preserved Batch 01 schemas.
export function sample(schema, mode, key = '', depth = 0) {
  if (schema.enum) {
    const preferred = [
      ...(mode === 'repair' ? ['blocker', 'survives'] : []),
      'pass',
      'demonstrated',
      'green',
      'flaky',
      'refactored',
      'done',
      'high',
      'go',
      'feature',
      'foundation',
    ];
    return preferred.find((x) => schema.enum.includes(x)) ?? schema.enum[0];
  }
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([name]) => mode !== 'empty' || (schema.required ?? []).includes(name))
        .map(([name, s]) => [name, sample(s, mode, name, depth + 1)]),
    );
  if (schema.type === 'array')
    return mode !== 'empty' && depth < 8 ? [sample(schema.items, mode, key, depth + 1)] : [];
  if (schema.type === 'boolean')
    return ![
      'refuted',
      'done',
      'allPassed',
      'allGreen',
      'clean',
      'fixed',
      ...(mode === 'repair'
        ? ['passed', 'green', 'covered', 'complete', 'adequate', 'isFoundation']
        : []),
    ].includes(key);
  if (schema.type === 'number' || schema.type === 'integer') return key === 'failures' ? 0 : 1;
  if (schema.type === 'null') return null;
  if (schema.type === 'string') {
    if (['file', 'path', 'location', 'testFile', 'netFile'].includes(key)) return 'src/sample.ts';
    if (['proposal', 'letter'].includes(key)) return 'A';
    if (key === 'plan') return 'spec';
    return 'sample';
  }
  throw new Error(`Unsupported fixture schema: ${JSON.stringify(schema)}`);
}
