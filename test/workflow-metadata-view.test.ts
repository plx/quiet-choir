import { expect, it } from 'vitest';
import {
  compactCapabilityManifest,
  compactWorkflowMetadata,
  withoutHarnessOptions,
  type CompactWorkflowMetadataView,
} from '../src/cli/workflow-metadata-view.js';
import { defineRoster, defineWorkflow, z } from '../src/index.js';
import type { WorkflowDescription } from '../src/workflow/runtime/child-model.js';
import { describeWorkflow } from '../src/workflow/runtime/definition.js';

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
    deciders: {},
    prompts: [],
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

const base = { version: '1', input: z.object({}), output: z.string() };
const leaf = (name: string, extra: Record<string, unknown> = {}) =>
  defineWorkflow({ ...base, name, ...extra, run: () => Promise.resolve('ok') });

/** Inverse of the compact view: restores every fact the full description states. */
function expand(view: CompactWorkflowMetadataView, entrypoint: string | null): unknown {
  const { capabilities, children, ...rest } = view;
  const { environment: shared, ...manifest } = capabilities;
  const full = Object.fromEntries(
    Object.entries(manifest.profiles).map(([name, profile]) => {
      const merged = shared
        ? {
            claude: profile.environment?.claude ?? shared.claude,
            codex: profile.environment?.codex ?? shared.codex,
          }
        : profile.environment;
      return [name, merged ? { ...profile, environment: merged } : profile];
    }),
  );
  const restored = {
    ...manifest,
    profiles: full,
    defaults: manifest.defaults ?? full[manifest.defaultProfile],
  };
  return {
    ...rest,
    entrypoint: 'entrypoint' in view ? view.entrypoint : entrypoint,
    capabilities: restored,
    children: children.map((child) => expand(child, child.entrypoint ?? null)),
  };
}

it('drops defaults and per-role environments for a default-only workflow', () => {
  const full = describeWorkflow(leaf('plain'), '/work/plain.workflow.ts');
  const view = compactWorkflowMetadata(full, '/work/plain.workflow.ts');
  expect(view.capabilities).not.toHaveProperty('defaults');
  expect(view.capabilities.environment).toEqual(
    full.capabilities.profiles[full.capabilities.defaultProfile]?.environment,
  );
  for (const role of Object.values(view.capabilities.profiles))
    expect(role).not.toHaveProperty('environment');
  // The removed workflow.profiles list (#726) is not printed.
  expect(view).not.toHaveProperty('profiles');
  expect(view).not.toHaveProperty('entrypoint');
});

it('keeps an entry environment only for the harnesses that differ from the default', () => {
  const full = describeWorkflow(
    leaf('envs', {
      defaults: { claude: { env: { set: { SHARED: '1' } } } },
      roster: defineRoster({
        Scout: { harness: 'claude', tools: ['Read'] },
        Vault: { harness: 'claude', tools: ['Read'], env: { set: { PRIVATE: 'x' } } },
      }),
    }),
  );
  const view = compactCapabilityManifest(full.capabilities);
  expect(view.defaultProfile).toBe('text');
  expect(view.environment).toEqual(full.capabilities.profiles['text']?.environment);
  expect(view.profiles['Scout']).not.toHaveProperty('environment');
  expect(view.profiles['Vault']?.environment).toEqual({
    claude: full.capabilities.profiles['Vault']?.environment?.claude,
  });
  expect(view.profiles['Vault']?.environment?.claude?.set).toEqual(['PRIVATE']);
  expect(Object.keys(view.profiles).sort()).toEqual(Object.keys(full.capabilities.profiles).sort());
});

it('round-trips to the full description at every child depth', () => {
  const grandchild = leaf('grandchild', {
    roster: defineRoster({ Deep: { harness: 'codex', env: { set: { D: '1' } } } }),
  });
  const child = leaf('child', {
    defaults: { claude: { env: { set: { C: '1' } } } },
    children: [grandchild],
  });
  const root = leaf('root', {
    roster: defineRoster({ Vault: { harness: 'claude', env: { set: { R: '1' } } } }),
    children: [child],
  });
  const full = describeWorkflow(root, '/work/root.workflow.ts');
  const view = compactWorkflowMetadata(full, '/work/root.workflow.ts');
  expect(expand(view, '/work/root.workflow.ts')).toEqual(withoutHarnessOptions(full));
  expect(view.children[0]?.capabilities).not.toHaveProperty('defaults');
  expect(view.children[0]?.children[0]?.capabilities).not.toHaveProperty('defaults');
  expect(Object.keys(view.children[0]?.children[0]?.capabilities.profiles ?? {})).toEqual([
    'text',
    'Deep',
  ]);
});

it('omits only the root entrypoint that equals the document copy', () => {
  const child = leaf('child');
  const full = describeWorkflow(leaf('root', { children: [child] }), '/work/root.workflow.ts');
  expect(compactWorkflowMetadata(full, '/work/root.workflow.ts')).not.toHaveProperty('entrypoint');
  expect(compactWorkflowMetadata(full, '/elsewhere.workflow.ts').entrypoint).toBe(
    '/work/root.workflow.ts',
  );
  expect(compactWorkflowMetadata(full, null).entrypoint).toBe('/work/root.workflow.ts');
  const view = compactWorkflowMetadata(full, '/work/root.workflow.ts');
  expect(view.children[0]?.entrypoint).toBe(full.children[0]?.entrypoint);
  expect(view.children[0]).toHaveProperty('entrypoint');
});

it('leaves a manifest without a matching default role unchanged and never mutates input', () => {
  const full = describeWorkflow(
    leaf('mut', { roster: defineRoster({ vault: { harness: 'claude' } }) }),
    '/work/mut.workflow.ts',
  );
  const before = structuredClone(full);
  compactWorkflowMetadata(full, '/work/mut.workflow.ts');
  expect(full).toEqual(before);
  const orphan = { ...full.capabilities, defaultProfile: 'absent' };
  const view = compactCapabilityManifest(orphan);
  expect(view.defaults).toBe(orphan.defaults);
  expect(view.profiles).toBe(orphan.profiles);
  expect(view).not.toHaveProperty('environment');
});
