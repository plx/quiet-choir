import { harnessDefinitions } from './harness-registry.js';
import { z } from 'zod';
import type { WorkflowDeclaration, WorkflowDescription } from './child-model.js';
import { jsonValue } from './json.js';
import { capabilityManifest } from './profiles.js';
import { schemaJson } from './schema.js';
import { checkWorktreePolicy } from './worktree-policy.js';
import { checkDecisionProviders } from './decision-protocol.js';
import { checkRosterDeciders, compileRoster } from './roster.js';
import { checkPromptSets, type PromptSetCheck } from '../prompts/check.js';
import { promptSetDescriptor, type PromptSetDescriptor } from '../prompts/prompt.js';

const metadataSchema = z.object({
  description: z.string().min(1).optional(),
  whenToUse: z.string().min(1).optional(),
  phases: z.array(z.object({ title: z.string().min(1), detail: z.string().optional() })).optional(),
});

/** Validate a trusted definition without invoking its workflow body. @internal */
export function checkedDefinition(value: unknown): WorkflowDeclaration {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(
      'Workflow must be a defineWorkflow({ name, version, input, output, run }) definition.',
    );
  const definition = value as Record<string, unknown>;
  for (const field of ['name', 'version'])
    if (typeof definition[field] !== 'string' || !definition[field].trim())
      throw new Error(`Workflow "${field}" must be a nonempty string.`);
  if (typeof definition['run'] !== 'function')
    throw new Error('Workflow "run" must be a function.');
  for (const field of ['input', 'output'])
    if (!(definition[field] instanceof z.ZodType))
      throw new Error(
        `Workflow "${field}" is not a zod 4 schema (zod/v3 and zod/mini are unsupported; import { z } from 'quiet-choir').`,
      );
  metadataSchema.parse(definition);
  if (definition['children'] !== undefined && !Array.isArray(definition['children']))
    throw new Error(
      `Workflow ${String(definition['name'])} children must be an array of definitions.`,
    );
  if (definition['harnesses'] !== undefined && !Array.isArray(definition['harnesses']))
    throw new Error(
      `Workflow ${String(definition['name'])} harnesses must be an array of definitions.`,
    );
  const roster = definition['roster'];
  if (
    roster !== undefined &&
    (typeof roster !== 'object' ||
      roster === null ||
      Array.isArray(roster) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(roster) as object | null))
  )
    throw new Error(
      `Workflow ${String(definition['name'])} roster must be a defineRoster({ ... }) object of named entries.`,
    );
  const prompts = definition['prompts'];
  if (
    prompts !== undefined &&
    (!Array.isArray(prompts) || prompts.some((set) => promptSetDescriptor(set) === undefined))
  )
    throw new Error(
      `Workflow ${String(definition['name'])} prompts must be an array of definePrompts(...) sets.`,
    );
  if (definition['requireGrants'] !== undefined && typeof definition['requireGrants'] !== 'boolean')
    throw new Error(`Workflow ${String(definition['name'])} requireGrants must be a boolean.`);
  if (definition['worktrees'] !== undefined)
    checkWorktreePolicy(
      definition['worktrees'],
      `Workflow ${String(definition['name'])} worktrees`,
    );
  const providers = checkDecisionProviders(definition['decisions'], String(definition['name']));
  // ADR 0066 section 2: a decider entry names one of this definition's own providers.
  checkRosterDeciders(
    roster,
    new Set(providers.map(({ name }) => name)),
    String(definition['name']),
  );
  harnessDefinitions(value as WorkflowDeclaration);
  return value as WorkflowDeclaration;
}

/**
 * Validate and publish a finite description of a possibly recursive declaration tree. Every node's
 * `requiredGrants` follows the root definition's `requireGrants`, since children inherit it.
 * @internal
 */
export function describeWorkflow(
  value: unknown,
  entrypoint: string | null = null,
): WorkflowDescription {
  type Description = { -readonly [K in keyof WorkflowDescription]: WorkflowDescription[K] } & {
    children: WorkflowDescription[];
  };
  const requireGrants = checkedDefinition(value).requireGrants === true;
  // ADR 0064 section 3: every node's prompt sets are checked; a set shared by several nodes once.
  const checkedSets = new Map<PromptSetDescriptor, PromptSetCheck>();
  const promptErrors: string[] = [];
  const promptSets = (definition: WorkflowDeclaration): PromptSetCheck[] =>
    (definition.prompts ?? []).map((set) => {
      const descriptor = promptSetDescriptor(set);
      if (descriptor === undefined) throw new Error('Unreachable: checked prompt set.');
      let checked = checkedSets.get(descriptor);
      if (checked === undefined) {
        const result = checkPromptSets([descriptor]);
        promptErrors.push(...result.errors);
        checked = result.sets[0] ?? { root: descriptor.root, entries: [] };
        checkedSets.set(descriptor, checked);
      }
      return checked;
    });
  const node = (
    value: unknown,
    source: string | null,
  ): { definition: WorkflowDeclaration; description: Description } => {
    const definition = checkedDefinition(value);
    const capabilities = capabilityManifest(definition, { requireGrants });
    return {
      definition,
      description: {
        harnesses: [...harnessDefinitions(definition).values()].map((item) => ({
          name: item.name,
          revision: item.revision,
          options: schemaJson(item.options),
          capabilities: item.capabilities,
          factory: item.createAdapter !== undefined,
          probe: item.probe !== undefined,
        })),
        name: definition.name,
        version: definition.version,
        description: definition.description ?? null,
        whenToUse: definition.whenToUse ?? null,
        phases: definition.phases ?? [],
        inputSchema: jsonValue(schemaJson(definition.input)),
        outputSchema: jsonValue(schemaJson(definition.output)),
        capabilities,
        profiles: Object.fromEntries(
          Object.keys(definition.profiles ?? {}).flatMap((name) => {
            const profile = capabilities.profiles[name];
            return profile ? [[name, profile]] : [];
          }),
        ),
        deciders: compileRoster(definition).deciders,
        prompts: promptSets(definition),
        children: [],
        recursive: false,
        entrypoint: source,
      },
    };
  };
  const root = node(value, entrypoint);
  const pending = [{ ...root, ancestors: [] as readonly WorkflowDeclaration[] }];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { definition, description, ancestors } = current;
    description.recursive = ancestors.includes(definition);
    if (description.recursive) continue;
    const names = new Set<string>();
    for (const child of definition.children ?? []) {
      const next = node(child, null);
      if (names.has(next.definition.name))
        throw new Error(
          `Workflow ${definition.name} declares duplicate child name ${next.definition.name}.`,
        );
      names.add(next.definition.name);
      description.children.push(next.description);
      pending.push({ ...next, ancestors: [...ancestors, definition] });
    }
  }
  if (promptErrors.length > 0)
    throw new Error(
      `Workflow ${root.definition.name} prompt templates failed their load-time checks:\n${promptErrors.map((error) => `- ${error}`).join('\n')}`,
    );
  return root.description;
}
