import { defineRoster } from '../../src/index.js';
import { choice, jevCompatible, noul } from '../../src/integrations/decision.js';

// The operator supplies the host: --harness-config '{"decisions":{"jev":{"baseUrl":"https://..."}}}'.
// The token is read from TYPESAFE_API_KEY at request time and never recorded.
export const jev = jevCompatible({
  name: 'jev',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  defaultModel: 'jev-latest',
});

// Two deciders and one tool-less agent, so the recipe needs no grant.
export const deskRoster = defineRoster({
  Triage: { decider: 'jev', description: 'Routes a support ticket before any agent runs.' },
  Grader: { decider: 'jev', description: 'Grades a drafted reply against its ticket.' },
  Responder: {
    harness: 'claude',
    description: 'Drafts a reply from the ticket text alone; uses no tools.',
    tools: [],
    maxTurns: 5,
    maxBudgetUsd: 1,
    timeoutMs: 600_000,
  },
});

export const route = choice({
  instructions:
    'Can a reply drafted from the ticket text alone resolve it, or must a human take it?',
  options: { answer: null, escalate: 'Needs account access, a refund or a judgment call.' },
});
export const resolved = noul({ instructions: 'Does the reply resolve the ticket?' });
