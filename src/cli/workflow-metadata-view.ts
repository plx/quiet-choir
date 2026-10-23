import type { WorkflowDescription } from '../workflow/runtime/child-model.js';
import { digest } from '../workflow/runtime/json.js';
import type { CapabilityManifest, ResolvedRole } from '../workflow/runtime/profiles-model.js';

type HarnessMetadataView = Omit<WorkflowDescription['harnesses'][number], 'options'>;

/** Workflow metadata without harness option schemas at any depth of the child tree. @internal */
export type WorkflowMetadataView<T extends WorkflowDescription> = Omit<
  T,
  'harnesses' | 'children'
> & {
  readonly harnesses: readonly HarnessMetadataView[];
  readonly children: readonly WorkflowMetadataView<WorkflowDescription>[];
};

/**
 * Print-time view of workflow metadata: drops each harness's option JSON Schema, at every depth of
 * the child tree, and keeps everything else. The input, and the registry cache it came from, is
 * not modified. @internal
 */
export function withoutHarnessOptions<T extends WorkflowDescription>(
  value: T,
): WorkflowMetadataView<T> {
  return {
    ...value,
    harnesses: value.harnesses.map((harness) =>
      Object.fromEntries(Object.entries(harness).filter(([key]) => key !== 'options')),
    ) as HarnessMetadataView[],
    children: value.children.map((child) => withoutHarnessOptions(child)),
  };
}

type EnvironmentPair = NonNullable<ResolvedRole['environment']>;

/** One role in the compact capability view: only the environments that differ. @internal */
export type CompactResolvedRole = Omit<ResolvedRole, 'environment'> & {
  readonly environment?: Partial<EnvironmentPair>;
};

/**
 * Capability manifest with each fact stated once: no `defaults` (read
 * `profiles[defaultProfile]`), and a shared `environment` that each role overrides only for the
 * harnesses that differ (`role.environment?.[h] ?? capabilities.environment[h]`). @internal
 */
export type CompactCapabilityManifest = Omit<CapabilityManifest, 'defaults' | 'profiles'> & {
  readonly defaults?: ResolvedRole;
  readonly environment?: EnvironmentPair;
  readonly profiles: Readonly<Record<string, CompactResolvedRole>>;
};

/** Workflow metadata as printed by `validate --json` and `list-defs --json`. @internal */
export type CompactWorkflowMetadataView = Omit<
  WorkflowMetadataView<WorkflowDescription>,
  'capabilities' | 'children' | 'entrypoint'
> & {
  readonly capabilities: CompactCapabilityManifest;
  readonly children: readonly CompactWorkflowMetadataView[];
  /** Absent on the root when it equals the document's own entrypoint. */
  readonly entrypoint?: string | null;
};

const ENVIRONMENT_HARNESSES = ['claude', 'codex'] as const;

/**
 * Print-time view of a capability manifest that states each fact once. Removes `defaults` (the
 * default role is named by `defaultProfile`), hoists the default role's environment into
 * `environment`, and keeps a role's `environment` only for harnesses whose summary differs.
 * The input is not modified; a manifest without a matching default role or environment is
 * returned structurally unchanged. @internal
 */
export function compactCapabilityManifest(manifest: CapabilityManifest): CompactCapabilityManifest {
  const { defaults, profiles, ...rest } = manifest;
  const baseline = profiles[manifest.defaultProfile]?.environment;
  if (!(manifest.defaultProfile in profiles)) return { ...rest, defaults, profiles };
  if (baseline === undefined) return { ...rest, profiles };
  const compacted = Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => {
      const { environment, ...others } = profile;
      if (environment === undefined) return [name, others];
      const differing = Object.fromEntries(
        ENVIRONMENT_HARNESSES.filter(
          (harness) => digest(environment[harness]) !== digest(baseline[harness]),
        ).map((harness) => [harness, environment[harness]]),
      ) as Partial<EnvironmentPair>;
      return [
        name,
        Object.keys(differing).length === 0 ? others : { ...others, environment: differing },
      ];
    }),
  ) as Record<string, CompactResolvedRole>;
  return { ...rest, environment: baseline, profiles: compacted };
}

/**
 * Print-time view for `validate --json` and `list-defs --json`: {@link withoutHarnessOptions}
 * plus {@link compactCapabilityManifest} at every depth, and the root `entrypoint` omitted when it equals `entrypoint`, the document's own copy. Child
 * nodes keep theirs. Nothing is modified in place. @internal
 */
export function compactWorkflowMetadata(
  value: WorkflowDescription,
  entrypoint: string | null,
): CompactWorkflowMetadataView {
  const node = compactNode(value);
  if (value.entrypoint !== entrypoint) return node;
  return Object.fromEntries(
    Object.entries(node).filter(([key]) => key !== 'entrypoint'),
  ) as unknown as CompactWorkflowMetadataView;
}

function compactNode(value: WorkflowDescription): CompactWorkflowMetadataView {
  const base = withoutHarnessOptions(value);
  return {
    ...base,
    capabilities: compactCapabilityManifest(value.capabilities),
    children: value.children.map((child) => compactNode(child)),
  };
}
