import { z } from 'zod';

import { jsonValue } from './json.js';
import type { JsonValue } from './model.js';

/** Convert a schema while omitting Zod's nonenumerable implementation metadata. @internal */
export function schemaJson(schema: z.ZodType): JsonValue {
  return jsonValue(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))));
}
