Prompt templates for test/prompts.test.ts and test/prompts-runtime.test.ts. Rendered text is step
identity, so the goldens asserted on these files are a gate, not a snapshot to refresh: an engine
bump or settings change that alters them needs an explicit decision (ADR 0064).
