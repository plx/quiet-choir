A sweep flagged this as dead code. Try to prove it is alive.

Candidate: {{ candidate.kind }} "{{ candidate.identifier }}" in {{ candidate.file }}, found by {{ modalities }} of three search modalities.
Sweep's evidence: {{ candidate.evidence }}

Hunt for the living references a sweep misses: dynamic import() or require with computed paths,
string-keyed registries and route tables, reflection, dependency-injection wiring, template
references, build and configuration consumers (bundler entries, CLI manifests), external consumers
if this package is published, and tests that exercise it indirectly.

If you find any plausible living reference, or this is a published package's public API, answer
alive and say where the reference is. When uncertain, answer alive: deleting live code breaks
production, while keeping dead code costs nothing. Read only; do not edit files.
