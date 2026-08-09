# 0001: Structure CLI commands as plan-execute adapters

- **Status:** Accepted
- **Date:** 2026-08-08

## Context

Quiet-choir will grow into a multi-command tool whose work may be initiated by a terminal today and
other integrations later. Parsing, execution, and presentation become difficult to test or reuse
when they are combined inside CLI command classes. Live framework and compiler objects also make
outcomes difficult to serialize, inspect, or transport.

## Decision

Every CLI command follows a plan-execute boundary:

1. The command parses and analyzes its input, creates a plain-data plan, and constructs the executor
   from explicit and ambient configuration.
2. The executor accepts that plan and performs the work.
3. The executor returns a plain-data result.
4. The command interprets and renders the result, including choosing output representation and exit
   status.

Plans and results use discriminated object types with string `kind` fields. They must remain
JSON-serializable and cannot contain errors, compiler objects, open handles, callbacks, or class
instances. Executors may receive live dependencies such as loggers through construction.

Oclif remains an outer adapter. Framework-independent application and workflow modules do not import
it.

## Consequences

- Executor behavior can be tested without spawning a CLI process.
- A plan or result can later be logged, cached, transported, or rendered as text, JSON, or JSONL.
- Native and third-party implementations can be replaced behind executor contracts.
- Command files retain explicit preparation, execution, and presentation phases.
- The design introduces some small data types and adapters even for placeholder commands; this is
  accepted to establish the boundary before commands become complex.
