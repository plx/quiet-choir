# Prompt templates

Keep long prompts in markdown templates instead of template literals. A TypeScript index declares
each template with a Zod parameter schema, and each entry becomes a pure, synchronous function that
returns a `Prompt`. Before any effect, `workflow validate`, the execute preflight, `list-defs` and
`runWorkflow` check every template the workflow lists in `prompts`.

```ts
import { definePrompts, defineRoster, defineWorkflow, z } from 'quiet-choir';

const Issue = z.object({ number: z.number(), title: z.string() });

// Templates live in prompts/ next to this module; shared fragments in prompts/_fragments/.
const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Review: {
    file: 'Review.md',
    params: z.object({ issue: Issue, diff: z.string() }),
    description: 'Review a diff against the issue it claims to close.',
  },
  ReviewerOrders: { file: 'ReviewerOrders.md', params: z.object({ repo: z.string() }) },
});

const roster = defineRoster({
  // Rendered once when the module loads; the entry stores the text.
  Reviewer: { harness: 'claude', appendSystemPrompt: prompts.ReviewerOrders({ repo: 'acme/api' }) },
});

export default defineWorkflow({
  name: 'templated-review',
  version: '1',
  input: z.object({ issue: Issue, diff: z.string() }),
  output: z.string(),
  roster,
  prompts: [prompts],
  run: (ctx, input) => ctx.roster.Reviewer.value('review', { prompt: prompts.Review(input) }),
});
```

`prompts/Review.md` reads its parameters as Jinja variables:

```jinja
---
description: Review a diff against the issue it claims to close.
---
# Review #{{ issue.number }}: {{ issue.title }}

{% include "_fragments/rules.md" %}

    {{ diff | indent(4) }}
```

## Declaration rules

- `root` is an absolute directory (`import.meta.dirname + '/prompts'`) or a `file:` URL; a relative
  root is refused. Names are identifiers, PascalCase by convention. An entry takes only `file` (a
  root-relative `.md` path inside the root), `params` (a `z.object`) and an optional `description`.
- A call parses its parameters with the schema and rejects unknown top-level keys, then renders. The
  function's parameter is typed from `z.input` of `params`, so a missing or extra key fails
  typecheck. There is no `ctx.prompts`: call the imported function.
- A `Prompt` is `{ text, template, params }`, frozen, and `toString()` returns `text`. `prompt` on
  every agent call (raw, `ctx.agent(name)`, bound, roster) and Claude `systemPrompt` and
  `appendSystemPrompt` (calls, `bind`, roster entries) accept it. The runtime sends its text and
  fingerprints it exactly like the equal string, so switching a literal to a template that renders
  the same text keeps completed steps reusable. Profiles, `defaults` and Codex options other than
  `prompt` take strings; use `.text` there.
- List every set in the workflow's `prompts`, and in each child that uses it, so the checks run.

## Template rules

- MiniJinja with fixed settings: strict undefined (a missing variable fails), no HTML escaping,
  `trimBlocks` and `lstripBlocks` (block-tag lines leave no blank line), one final newline dropped
  from every template including fragments, bounded fuel (a runaway loop fails with `OutOfFuel`).
  Built-in filters such as `tojson`, `indent`, `trim`, `join` and `default` work; there are no
  custom filters or globals, no date-time functions and no `dict.items()`.
- `random`, `randrange` and `lipsum` are removed, and any tag that names them fails the check.
- `include`, `extends`, `import` and `from` take exactly one string literal, resolved relative to
  the including file and confined to the root (no `..`, absolute path or escaping symlink). A
  computed target, a list and `ignore missing` are refused. From `_fragments/a.md`, `"b.md"` means
  `_fragments/b.md`.
- Front matter, if the file starts with `---`, may hold only `description:` with a string value; any
  other key is an error. It never reaches the rendered text, and the entry's `description` wins.
- Test an optional parameter with `{% if name is defined %}`; reading an omitted one fails.
- Rendered text is step identity: do not let a formatter rewrite template directories.

## Checks and errors

| Check                                                     | Result  |
| --------------------------------------------------------- | ------- |
| Entry file missing or unparsable; a fragment unparsable   | Error   |
| Dependency target computed, a list, `ignore missing`      | Error   |
| Dependency target outside the root or missing             | Error   |
| `\| random`, `randrange`, `lipsum` in a tag               | Error   |
| Entry reads a variable `params` does not declare          | Error   |
| Dotted path missing from a plain `z.object` (best effort) | Error   |
| `params` key nothing in the entry or its includes reads   | Warning |

`workflow validate --json` lists each node's checked sets under `workflow.prompts` (`[]` without
any): `{ root, entries: [{ name, file, description, variables, warnings }] }`. Errors fail
validation with exit 4 and name the prompt, file and line, for example
`Prompt Review (Review.md): reads variable autor, which its params schema does not declare`.
Warnings print as `[warn]` lines on stderr and appear in the JSON; `list-defs` reports the same
section and revalidates when a template changes. Fragments are not held to the schema (they may read
their includer's loop variables), so a misspelling there fails at render.

Every parameter, template or engine failure throws `PromptError` (`prompt`, `file`, `kind`, `line`),
a fatal authoring error: it fails the run even inside an `onError: 'return'` map or step, is never
retried, and is never journaled as a settled item. A template edit is not yet refused on resume the
way a code edit is; a completed step whose rendered prompt changed still fails its own fingerprint
check.
