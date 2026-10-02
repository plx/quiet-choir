import { existsSync } from 'node:fs';

import { defineWorkflow, z } from '../../../src/index.js';

// QC002: the body branches on a live filesystem read.
export default defineWorkflow({
  name: 'durability-m05-exists-sync',
  version: '1',
  input: z.object({ file: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    if (existsSync(input.file)) {
      return ctx.step('gate', { input: {}, schema: z.string(), run: () => 'present' });
    }
    return 'absent';
  },
});
