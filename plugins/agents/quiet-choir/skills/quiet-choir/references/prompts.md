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

{% include "_fragments/rules.md" +%}

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
  the same text keeps completed steps reusable. Roster entries, `defaults` and Codex options other
  than `prompt` take strings; use `.text` there.
- List every set in the workflow's `prompts`, and in each child that uses it, so the checks run.

## Template rules

- MiniJinja with fixed settings: strict undefined (a missing variable fails), no HTML escaping,
  `trimBlocks` and `lstripBlocks` (a tag-only line vanishes; any block tag or comment also eats the
  newline after it), one final newline dropped from every template including fragments, bounded fuel
  (a runaway loop fails with `OutOfFuel`). Built-in filters such as `tojson`, `indent`, `trim`,
  `join` and `default` work; there are no custom filters or globals, no date-time functions and no
  `dict.items()`.
- End a tag that closes a line of text with `+%}`. Write `{% include "x.md" +%}` for a fragment that
  ends in text. Prefer tag-only lines to `{%-`/`-%}`, which also strip blank lines.
  `docs/prompts.md#whitespace` in the repository has rendered recipes.
- `random`, `randrange` and `lipsum` are removed, and any tag that names them fails the check.
- `include`, `extends`, `import` and `from` take exactly one string literal, resolved relative to
  the including file and confined to the root (no `..`, absolute path, escaping symlink, or path
  through a directory symlink back to an ancestor directory such as `sub/up -> ..`). A computed
  target, a list and `ignore missing` are refused. From `_fragments/a.md`, `"b.md"` means
  `_fragments/b.md`.
- Front matter, if the file starts with `---`, may hold only `description:` with a string value; any
  other key is an error. It never reaches the rendered text, and the entry's `description` wins.
- Test an omitted parameter with `{% if name is defined %}`; reading one fails. `null` prints `None`
  and `default('x')` keeps it: guard a `.nullable()` parameter with `{% if name is not none %}` or
  write `name or 'x'`.
- Values print verbatim: fence untrusted text with `| tojson(indent=2)` (`std.exec.json`'s layout,
  `<>&'` escaped) or `| replace('</tag', '<\\/tag')` (both backslashes); `std.exec.json` does not
  escape. A fence is not a security boundary: also say in the prompt that fenced text is data.
- Rendered text is step identity: do not let a formatter rewrite template directories.

## Checks and errors

| Check                                                            | Result  |
| ---------------------------------------------------------------- | ------- |
| Entry file missing or unparsable; a fragment unparsable          | Error   |
| Dependency target computed, a list, `ignore missing`             | Error   |
| Dependency target outside the root or missing                    | Error   |
| `\| random`, `randrange`, `lipsum` in a tag                      | Error   |
| Entry reads a variable `params` does not declare                 | Error   |
| Dotted path missing from a plain `z.object` (best effort)        | Error   |
| `params` key nothing in the entry, its includes or imports reads | Warning |

`workflow validate --json` lists each node's checked sets under `workflow.prompts` (`[]` without
any): `{ root, entries: [{ name, file, description, variables, warnings }] }` (`variables`: the
top-level variables the entry file itself reads, not those of its includes). Errors fail validation
with exit 4 and name the prompt, file and line, for example
`Prompt Review (Review.md): reads variable autor, which its params schema does not declare`.
Warnings print as `[warn]` lines on stderr and appear in the JSON; `list-defs` reports the same
section and revalidates when a template changes. Fragments are not held to the schema (they may read
their includer's loop variables), so a misspelling there fails at render.

Every parameter, template or engine failure throws `PromptError` (`prompt`, `file`, `kind`, `line`),
a fatal authoring error: it fails the run even inside an `onError: 'return'` map or step, is never
retried, and is never journaled as a settled item.

## Templates are execution dependencies

Every file under each declared prompt root of the static workflow tree (the workflow's `prompts` and
its declared children's), referenced or not, joins `workflow.identity.files` and `launch.sources`
beside the TypeScript sources, keyed by its path from the project root such as `prompts/Review.md`.
Validate, `check-resume` and execute report the same fingerprint. A directory symlink that leaves
the root or loops back to an ancestor is not walked, and a template path through one is refused, so
every file a render reads is hashed.

- Editing, adding or removing any file under a root between runs is a code change: resume and
  `check-resume` refuse with `Workflow code (prompts/Review.md) changed; ...`, the path also in
  `files`.
- `--accept-code-change` waives that and records the files in `codeChanges`, but a completed step
  whose rendered prompt changed still fails its own fingerprint check: the preflight refuses with
  `Step <id>: prompt changed on a completed step` and a `--fork-from ... --invalidate <id>` command,
  and changes nothing. An edit no completed step renders (an unused fragment) resumes under the
  flag.
- Forks follow the code rules. A dynamic `ctx.workflow` child outside the static tree is checked at
  start but not fingerprinted. A run launched by an earlier build from a prompt-declaring workflow
  needs one `--accept-code-change`.
- Keep varying text in parameters, not in template edits, when a prompt must change without an
  acceptance.

When a call's `prompt` is a `Prompt`, the step and attempt request summaries record its name as
`promptTemplate` (schema revision 20); a string prompt or a `Prompt` only in a system prompt records
nothing. It is outside identity. `workflow inspect` prints `template <Name>` on agent lines,
`inspect --json` has `request.promptTemplate` and `agents.recent[].promptTemplate`, and `onEvent`
sees `promptTemplate` on `agent.finished`.
