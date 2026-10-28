// The prompt index: every agent prompt as a markdown template with typed parameters. Shared text is
// in prompts/_fragments: Evidence.md (reads manifests, evidence, evidenceOmitted), Breaking.md
// (breaking) and Failures.md (failures).
import { definePrompts, z } from 'quiet-choir';
import { Cluster, Failure, Impact, Research } from './contracts.js';

const evidence = {
  manifests: z.array(z.string()),
  evidence: z.array(z.string()).describe('Manifest and lockfile lines naming the package'),
  evidenceOmitted: z.number().int().nonnegative(),
};
const upgrade = { package: z.string(), from: z.string(), to: z.string() };
const breaking = { breaking: Research.shape.breakingChanges };
const approved = {
  digest: z.string(),
  plan: z.string().describe('The approved plan as indented JSON'),
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Research: {
    file: 'Research.md',
    description:
      'Read the changelog and migration guide for every breaking change up to the target.',
    params: z.object({ package: z.string(), toVersion: z.string().nullable(), ...evidence }),
  },
  Impact: {
    file: 'Impact.md',
    description:
      'Map which files use which APIs of the package, classifying every code-found file.',
    params: z.object({
      package: z.string(),
      ...evidence,
      files: z.array(z.string()).describe('Tracked files code found the name in'),
      unmapped: z.number().int().nonnegative(),
    }),
  },
  Plan: {
    file: 'Plan.md',
    description: 'Join the breaking changes with the usage map into an ordered, scoped plan.',
    params: z.object({
      ...upgrade,
      ...breaking,
      usage: Impact.shape.usageSites,
      exposure: z.string().nullable(),
      manifests: z.array(z.string()),
      install: z.string().nullable(),
      verify: z.array(z.string()),
    }),
  },
  Apply: {
    file: 'Apply.md',
    description: 'Apply the approved plan in an isolated checkout; the plan JSON comes last.',
    params: z.object({ ...upgrade, install: z.string().nullable(), ...approved }),
  },
  Triage: {
    file: 'Triage.md',
    description:
      'Cluster the code-run failures by root cause, for the fixers or, at the cap, for the report.',
    params: z.object({
      ...upgrade,
      ...breaking,
      install: z.string().nullable(),
      repair: z.boolean().describe('Fixers follow; false at the fix-round cap'),
      testFocus: z.array(z.string()),
      allowed: z.array(z.string()),
      failures: z.array(Failure),
    }),
  },
  Fix: {
    file: 'Fix.md',
    description: 'Fix one failure cluster forward, in the files it owns; the plan JSON comes last.',
    params: z.object({
      ...upgrade,
      ...breaking,
      cluster: Cluster,
      failures: z.array(Failure),
      ...approved,
    }),
  },
});
