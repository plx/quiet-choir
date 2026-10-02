import { expect, it } from 'vitest';
import {
  gradeHarnessVersion,
  testedHarnessVersions,
  untestedVersionWarning,
} from '../src/harnesses/tested-versions.js';

const range = { minimum: '2.1.283', maximum: '2.1.290' };
const wide = { minimum: '2.1.283', maximum: '2.3.5' };

it.each([
  ['2.1.283', range, 'pass'],
  ['2.1.285', range, 'pass'],
  ['2.1.290', range, 'pass'],
  ['2.1.282', range, 'warn'],
  ['2.1.291', range, 'warn'],
  ['2.1.1000', range, 'warn'],
  ['2.2.0', range, 'fail'],
  ['3.1.285', range, 'fail'],
  ['2.0.999', range, 'fail'],
  ['1.1.285', range, 'fail'],
  [null, range, 'fail'],
  ['', range, 'fail'],
  ['abc', range, 'fail'],
  ['2.1', range, 'fail'],
  ['2.1.285-beta.1', range, 'fail'],
  ['2.1.285+build', range, 'fail'],
  ['2.1.9999999999999999999', range, 'fail'],
  // Components compare numerically, not lexically.
  ['2.1.999', { minimum: '2.1.9', maximum: '2.1.1000' }, 'pass'],
  ['2.1.1001', { minimum: '2.1.9', maximum: '2.1.1000' }, 'warn'],
  ['2.2.0', wide, 'pass'],
  ['2.3.5', wide, 'pass'],
  ['2.1.0', wide, 'warn'],
  ['2.3.9', wide, 'warn'],
  ['2.4.0', wide, 'fail'],
  ['0.157.1', testedHarnessVersions.codex, 'pass'],
  ['0.157.2', testedHarnessVersions.codex, 'warn'],
  ['0.158.0', testedHarnessVersions.codex, 'fail'],
] as const)('grades %s against %j as %s', (version, bounds, grade) => {
  expect(gradeHarnessVersion(version, bounds)).toBe(grade);
});

it('treats unparseable bounds as untrusted', () => {
  expect(gradeHarnessVersion('2.1.283', { minimum: 'x', maximum: '2.1.283' })).toBe('fail');
});

it('builds a deterministic untested-version warning that names the doctor', () => {
  const text = untestedVersionWarning('claude', 'claude', '2.1.285');
  expect(text).toBe(untestedVersionWarning('claude', 'claude', '2.1.285'));
  expect(text).toContain('claude@2.1.285');
  expect(text).toContain(
    `${testedHarnessVersions.claude.minimum}..${testedHarnessVersions.claude.maximum}`,
  );
  expect(text).toContain('quiet-choir configuration doctor --harness claude');
});
