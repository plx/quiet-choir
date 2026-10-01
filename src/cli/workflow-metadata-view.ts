import type { WorkflowDescription } from '../workflow/runtime/child-model.js';

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
