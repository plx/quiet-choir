import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';
import { register as registerCommonJs } from 'tsx/cjs/api';
import { checkedDefinition } from '../runtime/definition.js';
import type { WorkflowDefinition } from '../runtime/model.js';
import type { TypecheckPlan } from '../typecheck/model.js';

/** Distinguish invalid exports from failures while importing trusted code. @internal */
export class WorkflowDefinitionError extends Error {
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkflowDefinitionError';
  }
}

/** Import already type-checked, trusted workflow code, preserving the CommonJS loader until disposed. @internal */
export async function importWorkflow(
  plan: TypecheckPlan,
): Promise<{ definition: WorkflowDefinition<unknown, unknown>; dispose?: () => void }> {
  const format = ts.getImpliedNodeFormatForFile(plan.entrypoint, undefined, ts.sys, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  let dispose: (() => void) | undefined;
  try {
    let module: unknown;
    if (format === ts.ModuleKind.CommonJS) {
      const registered = registerCommonJs({ namespace: randomUUID() });
      dispose = registered.unregister;
      module = registered.require(plan.entrypoint, import.meta.url);
    } else {
      module = await tsImport(plan.entrypoint, {
        parentURL: import.meta.url,
        ...(plan.configuration.kind === 'tsconfig' ? { tsconfig: plan.configuration.path } : {}),
      });
    }
    try {
      const definition: unknown =
        module !== null && typeof module === 'object' ? Reflect.get(module, 'default') : undefined;
      if (definition === null || typeof definition !== 'object')
        throw new Error(
          'Workflow must default-export a defineWorkflow({ name, version, input, output, run }) definition.',
        );
      return {
        definition: checkedDefinition(definition) as unknown as WorkflowDefinition<
          unknown,
          unknown
        >,
        ...(dispose === undefined ? {} : { dispose }),
      };
    } catch (cause) {
      throw new WorkflowDefinitionError(cause);
    }
  } catch (cause) {
    dispose?.();
    throw cause;
  }
}
