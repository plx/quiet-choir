import { expect, it } from 'vitest';
import { withoutHarnessOptions } from '../src/cli/workflow-metadata-view.js';
import type { WorkflowDescription } from '../src/workflow/runtime/child-model.js';

const harness = (name: string) => ({
  name,
  revision: 1,
  options: { type: 'object', properties: { model: { type: 'string' } } },
  capabilities: { structuredOutput: true, tools: true },
  factory: true,
  probe: false,
});

function description(name: string, children: WorkflowDescription[] = []): WorkflowDescription {
  return {
    harnesses: [harness('claude'), harness('codex')],
    name,
    version: '1',
    description: `about ${name}`,
    whenToUse: null,
    phases: [],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    capabilities: {},
    profiles: {},
    children,
    recursive: false,
    entrypoint: `/work/${name}.workflow.ts`,
  } as unknown as WorkflowDescription;
}

function optionKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => optionKeys(item, `${path}[${String(i)}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === 'harnesses' && Array.isArray(item)
      ? item
          .flatMap((entry: object, i) =>
            'options' in entry ? [`${path}.harnesses[${String(i)}].options`] : [],
          )
          .concat(optionKeys(item, `${path}.harnesses`))
      : optionKeys(item, `${path}.${key}`),
  );
}

it('drops harness option schemas at every child depth and keeps everything else', () => {
  const tree = {
    ...description('root', [description('child', [description('grandchild')])]),
    fingerprint: 'abc',
    identity: { name: 'root' },
  };
  const before = structuredClone(tree);
  expect(optionKeys(tree).length).toBe(6);
  const view = withoutHarnessOptions(tree);
  expect(optionKeys(view)).toEqual([]);
  expect(view.harnesses.map((entry) => entry.name)).toEqual(['claude', 'codex']);
  expect(view.harnesses[0]).toEqual({
    name: 'claude',
    revision: 1,
    capabilities: { structuredOutput: true, tools: true },
    factory: true,
    probe: false,
  });
  expect(view.children[0]?.children[0]).toMatchObject({
    name: 'grandchild',
    entrypoint: '/work/grandchild.workflow.ts',
    inputSchema: { type: 'object' },
  });
  expect(view).toMatchObject({ fingerprint: 'abc', identity: { name: 'root' }, version: '1' });
  expect(tree).toEqual(before);
});
