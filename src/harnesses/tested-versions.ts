/**
 * Contract-tested version bounds. They describe the range that `npm run test:contract` verified;
 * widen them only with that evidence. Versions inside the range pass the doctor's version check, an
 * untested patch of a tested major.minor warns, and anything else fails.
 */
export const testedHarnessVersions = {
  /** Captured Claude Code installation. */
  claude: {
    /** Oldest verified version. */
    minimum: '2.1.283',
    /** Newest verified version. */
    maximum: '2.1.283',
  },
  /** Captured Codex CLI installation. */
  codex: {
    /** Oldest verified version. */
    minimum: '0.157.1',
    /** Newest verified version. */
    maximum: '0.157.1',
  },
} as const;

/** Verdict for one observed harness version: inside the range, untested patch, or untrusted. */
export type HarnessVersionGrade = 'pass' | 'warn' | 'fail';

/** Inclusive MAJOR.MINOR.PATCH bounds of a tested range. */
export interface HarnessVersionBounds {
  /** Oldest verified version. */
  readonly minimum: string;
  /** Newest verified version. */
  readonly maximum: string;
}

type Triple = readonly [number, number, number];

/** Parse an exact digits-only MAJOR.MINOR.PATCH; prerelease and build suffixes are unparseable. */
function parseTriple(version: string): Triple | null {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version);
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return [major, minor, patch].every(Number.isSafeInteger) ? [major, minor, patch] : null;
}

function compare(left: Triple, right: Triple): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

const sameMinor = (left: Triple, right: Triple): boolean =>
  left[0] === right[0] && left[1] === right[1];

/**
 * Grade a discovered version against inclusive bounds. Inside the range is `pass`; outside it but
 * on the same major.minor as a bound is `warn` (an untested patch); everything else, including a
 * missing, prerelease, build-suffixed or unparseable version, is `fail`.
 */
export function gradeHarnessVersion(
  version: string | null,
  bounds: HarnessVersionBounds,
): HarnessVersionGrade {
  const observed = version === null ? null : parseTriple(version);
  const minimum = parseTriple(bounds.minimum);
  const maximum = parseTriple(bounds.maximum);
  if (!observed || !minimum || !maximum) return 'fail';
  if (compare(observed, minimum) >= 0 && compare(observed, maximum) <= 0) return 'pass';
  return sameMinor(observed, minimum) || sameMinor(observed, maximum) ? 'warn' : 'fail';
}

/** Deterministic run-time warning for a discovered version outside the tested range. */
export function untestedVersionWarning(
  harness: keyof typeof testedHarnessVersions,
  binary: string,
  version: string,
): string {
  const { minimum, maximum } = testedHarnessVersions[harness];
  return `${binary}@${version} is outside quiet-choir's contract-tested ${harness} range ${minimum}..${maximum}; run \`quiet-choir configuration doctor --harness ${harness}\` to verify its argv before relying on it.`;
}
