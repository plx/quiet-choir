// The decision provider and the one question the Gatekeeper answers (ADR 0066). The operator
// supplies the host only for autoApprove runs:
// --harness-config '{"decisions":{"jev":{"baseUrl":"https://..."}}}', with the token in
// TYPESAFE_API_KEY. Fixture and dry runs need neither.
import { choice, jevCompatible } from 'quiet-choir/decision';

export const jev = jevCompatible({
  name: 'jev',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  defaultModel: 'jev-latest',
});

export const proceed = choice({
  instructions:
    'A lifecycle stage finished and its own gate passed. Can the next stage safely build on this result without a human looking first?',
  options: {
    continue: 'The result is complete and consistent with the goal.',
    review: 'Open questions, thin evidence or a surprising result; a human should look.',
  },
});
