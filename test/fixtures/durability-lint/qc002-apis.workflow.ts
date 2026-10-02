import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { defineWorkflow, z, type WorkflowContext } from '../../../src/index.js';

// QC002 forms: each nondeterministic API, in the body, a nested function and a ctx helper.
async function stamp(ctx: WorkflowContext): Promise<string> {
  return ctx.step('stamp', {
    input: { at: new Date().toISOString() },
    schema: z.string(),
    run: () => 'x',
  });
}

export default defineWorkflow({
  name: 'durability-qc002-apis',
  version: '1',
  input: z.object({ file: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    const values = [
      Date(),
      String(performance.now()),
      crypto.randomUUID(),
      randomUUID(),
      String(new Date(0).getTime()),
    ];
    const read = () => fs.readFileSync(input.file, 'utf8');
    return `${values.join('')}${read()}${await stamp(ctx)}`;
  },
});
