import { describe, expect, it } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { createStubPlan, StubExecutor } from '../src/application/stub.js';
import { createVersionPlan, VersionExecutor } from '../src/application/version.js';
import { formatStubResult, formatTypecheckDiagnostic } from '../src/cli/presentation.js';

const silentLogger = new ThresholdLogger('silent', () => {
  throw new Error('The silent logger must not write.');
});

describe('execution primitives', () => {
  it('filters and labels executor log records', () => {
    const lines: string[] = [];
    const logger = new ThresholdLogger('info', (line) => {
      lines.push(line);
    });

    logger.log('trace', 'hidden trace');
    logger.log('info', 'visible information');
    logger.log('error', 'visible error');

    expect(lines).toEqual(['[info] visible information', '[error] visible error']);
  });

  it('suppresses every record at the silent level', () => {
    const lines: string[] = [];
    const logger = new ThresholdLogger('silent', (line) => {
      lines.push(line);
    });

    logger.log('fatal', 'hidden fatal');

    expect(lines).toEqual([]);
  });

  it('executes and renders a serializable stub plan', async () => {
    const plan = createStubPlan('workflow.execute');
    const result = await new StubExecutor(silentLogger).execute(plan);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(formatStubResult(result)).toBe('workflow execute is not implemented yet.');
  });

  it('executes a version plan with its configured runtime version', async () => {
    const result = await new VersionExecutor('1.2.3', silentLogger).execute(createVersionPlan());

    expect(result).toEqual({ kind: 'info.version.result', version: '1.2.3' });
  });
});

describe('diagnostic presentation', () => {
  it('renders source locations relative to the current directory', () => {
    expect(
      formatTypecheckDiagnostic(
        {
          category: 'error',
          code: 2322,
          column: 7,
          filePath: '/workspace/project/workflow.ts',
          line: 3,
          message: "Type 'string' is not assignable to type 'number'.",
        },
        '/workspace/project',
      ),
    ).toBe("workflow.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.");
  });

  it('renders diagnostics without source positions', () => {
    expect(
      formatTypecheckDiagnostic(
        {
          category: 'error',
          code: 5023,
          column: null,
          filePath: null,
          line: null,
          message: "Unknown compiler option 'mystery'.",
        },
        '/workspace/project',
      ),
    ).toBe("error TS5023: Unknown compiler option 'mystery'.");
  });

  it('omits a position when a diagnostic only identifies a file', () => {
    expect(
      formatTypecheckDiagnostic(
        {
          category: 'warning',
          code: 1,
          column: null,
          filePath: '/workspace/project/workflow.ts',
          line: null,
          message: 'A warning',
        },
        '/workspace/project',
      ),
    ).toBe('workflow.ts - warning TS1: A warning');
  });
});
