# 0064: Render prompts from template files and treat them as execution dependencies

- Status: proposed
- Issue: #19
- Builds on: [0005](0005-step-identity-and-policy.md) (prompt in step identity),
  [0006](0006-code-change-recovery.md) (source drift and explicit acceptance),
  [0011](0011-harness-controls-and-contracts.md) (role prompts travel as private files) and
  [0063](0063-bound-agents-and-typed-rosters.md) (roster standing prompts)

## Context

Large workflows are illegible when control flow and prompt building share a file. The two native
Claude Code scripts this project was meant to replace spend 330 lines on template literals across 17
agent calls, and the idiomatic Batch 02 ports are still roughly a third prose. Issue #19 asked for
Jinja-style template files that workflow code references by name, with parameters that can be
checked before any paid call, and for templates to count as execution dependencies.

Today an agent step's prompt is hashed into its identity, so a changed prompt is caught at the use
site on replay. A template file, however, is invisible to `fingerprintSources`, which only follows
compiler-discovered TypeScript and the nearest tsconfig, so a template edit is not refused at launch
the way a code edit is, and `promptPreview` keeps only the first 200 characters.

Roster entries (ADR 0063) need standing instructions rendered with concrete values when a module
loads, which requires a pure, synchronous renderer.

## Decision

### 1. Engine

Use `minijinja-js`, the official WebAssembly binding of MiniJinja, behind a small internal adapter
(`src/workflow/prompts/engine.ts`) so the engine can be replaced without touching callers. Its Node
entry initializes synchronously, so rendering is a plain function call. Fixed environment settings:

| Setting                      | Value    | Reason                                             |
| ---------------------------- | -------- | -------------------------------------------------- |
| `undefinedBehavior`          | `strict` | a missing or misspelled variable is an error       |
| `autoEscape`                 | `none`   | prompts are markdown, not HTML                     |
| `trimBlocks`, `lstripBlocks` | `true`   | block tags leave no blank lines in prose           |
| `keepTrailingNewline`        | `false`  | one spelling for the end of a prompt               |
| `fuel`                       | bounded  | a runaway loop fails instead of hanging the loader |
| globals and custom filters   | none     | a render is a pure function of its parameters      |

MiniJinja's built-in filters (`tojson`, `indent`, `trim`, `join`, `default`, ...) are available.
`include` and `extends` resolve relative to the including file and must stay inside the template
root; a path that escapes it is an error.

### 2. Declaration: a TypeScript index over markdown files

```ts
// prompts.ts
export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  ReviewAgainstIssue: {
    file: 'ReviewAgainstIssue.md',
    params: z.object({ issue: Issue, diff: z.string(), threads: z.array(Thread) }),
    description: 'Review a PR diff against the issue it claims to close.',
  },
  ReviewerStandingOrders: {
    file: 'ReviewerStandingOrders.md',
    params: z.object({ repo: z.string() }),
  },
});

// anywhere, including a roster module:
const prompt = prompts.ReviewAgainstIssue({ issue, diff, threads }); // string, pure, synchronous
```

- `definePrompts(root, entries)` returns one function per key, typed from its Zod `params`.
  Rendering parses the parameters with the schema (unknown keys rejected), then renders. A parameter
  or template error is an authoring error (`isFatal`), never a retryable step failure.
- Prompt names are identifiers (`/^[A-Za-z][A-Za-z0-9_]*$/`), PascalCase by convention. Files are
  markdown under `root`; fragments shared by `include` live under `root/_fragments/`.
- Front matter is reserved. A file that begins with `---` must contain only a `description` key;
  anything else is an error, so a future descriptor format cannot be silently rendered as prose.
  Nothing in front matter reaches the rendered prompt.
- `defineWorkflow` gains a `prompts` field listing the prompt sets a workflow uses. A package
  (ADR 0065) lists them once on its manifest. The field exists for validation and fingerprinting;
  calls are plain function calls, and there is no `ctx.prompts`.

### 3. Static checks at load

`workflow validate`, the execute preflight and `list-defs` all run these on every declared prompt
set before any effect:

- every `file` exists under `root` and parses; every `include` and `extends` resolves inside `root`;
- the template's undeclared variables (MiniJinja reports them) are a subset of the schema's
  top-level keys, otherwise an error naming the template and the variable; nested paths such as
  `issue.number` are checked against the schema where it is a plain object, best effort;
- a schema key the template never reads is a warning.

The results appear under `prompts` in `validate --json`. This is the cross-check the author asked
for; a dedicated `prompts check` subcommand can alias it later if wanted.

### 4. Templates are execution dependencies

Every declared template file, and every file it includes, joins `launch.sources` as path and SHA-256
beside the TypeScript sources. The rules of ADR 0006 apply unchanged: a changed template on resume
is refused unless `--accept-code-change` is given, and even then a completed step whose rendered
prompt changed fails its own fingerprint check because the prompt is identity. Forks follow the same
rules as code.

### 5. Records

An agent step record gains an optional observational `promptTemplate: string` (the prompt name)
beside `promptPreview`. It is outside identity (ADR 0015), follows the record schema revision rule
of ADR 0052, and `inspect` shows it so a reader can find the template without reading the preview.

## Alternatives

- **Nunjucks.** Rejected: its divergences from Jinja2 are known and the author knows Jinja;
  MiniJinja's design goal is Jinja2 fidelity, and the same templates render identically under its
  Rust and Python bindings.
- **Parameter descriptors in front matter with generated `.d.ts` files.** Rejected for this
  revision: a TypeScript index gives typed parameters with no generation step or staleness check,
  and the front matter stays reserved for a later descriptor format.
- **A tagged template literal in TypeScript** (the earlier suggestion on #19). Rejected: it keeps
  the prose in the code, which is the problem being solved.
- **Rendering inside the runtime as a durable effect.** Rejected: a render is pure and synchronous,
  and making it an effect would add records without adding durability.

## Consequences

- `minijinja-js` becomes a pinned runtime dependency (about 900 KB unpacked, WebAssembly) and is
  loaded only when a definition declares prompts. The package's README calls the binding
  experimental; the adapter module is the mitigation.
- The agent step record gets one optional field (schema revision). `WorkflowDefinition.prompts`
  joins `model.ts`, so the Workflow Lab `apiSnapshot` hash is bumped with ADR 0063's change.
- A template edit is now refused at launch like a code edit. Authors who want a prompt to change
  without a code-change acceptance should keep the varying text in parameters.
- The proof of the design is extracting the prompts from one Batch 02 port and from the ported
  native scripts (ADR 0065) and reading what remains as control flow. `definePrompts` is exported
  from the root entry point; a `docs/prompts.md` page documents the engine subset and the checks.
