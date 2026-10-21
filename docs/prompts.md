# Prompt templates

Long prompts can live in markdown template files instead of template literals.
[ADR 0064](decisions/0064-prompt-templates-as-execution-dependencies.md) §1–3 describes the design.
A TypeScript index declares each template with a Zod schema for its parameters. Each entry becomes a
plain, synchronous function that returns a `Prompt`. Before any effect, `workflow validate`, the
execute preflight, `list-defs` and `runWorkflow` check every template a workflow lists.

Templates are not yet execution dependencies: ADR 0064 §4–5 (#582) is not implemented. A template
edit is not refused when a run resumes, unlike a code edit, and agent records do not name the
template. The rendered text is part of step identity, though. So if a completed step's rendered
prompt changes, that step still fails its fingerprint check on replay, the same as an edited string
literal.

## Declare prompts

```ts
// prompts.ts
import { definePrompts, z } from 'quiet-choir';

const Issue = z.object({ number: z.number(), title: z.string() });

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Review: {
    file: 'Review.md',
    params: z.object({ issue: Issue, diff: z.string(), threads: z.array(z.string()) }),
    description: 'Review a diff against the issue it claims to close.',
  },
  ReviewerOrders: { file: 'ReviewerOrders.md', params: z.object({ repo: z.string() }) },
});
```

```ts
// review.workflow.ts
export default defineWorkflow({
  name: 'review',
  version: '1',
  input: z.object({ issue: Issue, diff: z.string() }),
  output: z.string(),
  prompts: [prompts],
  async run(ctx, { issue, diff }) {
    const reply = await ctx.claude.text('review', {
      prompt: prompts.Review({ issue, diff, threads: [] }),
    });
    return reply.output;
  },
});
```

- `root` is an absolute directory or a `file:` URL. A relative root is refused, because it would
  resolve against the directory the CLI happened to run from.
- Prompt names are identifiers (`/^[A-Za-z][A-Za-z0-9_]*$/`), PascalCase by convention. An entry
  takes only `file`, `params` (a `z.object`) and an optional nonempty `description`. `file` is a
  root-relative POSIX path ending in `.md` that stays inside the root.
- `definePrompts` checks its arguments but reads no file. It returns a frozen object with one
  function per entry. Each function's parameter is typed from `z.input` of the entry's `params`.
- A call parses its parameters with `params.strict()`, so an unknown top-level key is rejected, then
  renders the template. There is no `ctx.prompts`; prompts are ordinary imported functions.
- List the set in the workflow's `prompts` so the [load-time checks](#load-time-checks) run. A child
  workflow lists its own sets. Listing a set changes nothing about how it renders.

## The Prompt value

A prompt function returns a frozen `Prompt`:

| Field      | Value                                                     |
| ---------- | --------------------------------------------------------- |
| `text`     | The rendered text, exactly what the agent receives        |
| `template` | The prompt's name in its index, such as `Review`          |
| `params`   | The parameters after schema parsing, as the template read |

`toString()` returns `text`, so `String(prompt)` and template literals give the rendered string. The
following options accept a `Prompt` anywhere they accept a string:

- `prompt`, on raw calls, `ctx.agent(name)`, bound agents and roster agents;
- Claude `systemPrompt` and `appendSystemPrompt`, on calls, `bind` and roster entries.

The runtime replaces the `Prompt` with its text before computing step identity. A `Prompt` and the
equal string therefore fingerprint, record, rehearse and replay identically, and adapters always
receive a string (`PromptText<O>` types their options). Profiles, `defaults`, Codex options, native
subagent `agents` and `ctx.ask` still take strings; use `.text` there.

## Template language and fixed settings

Templates use [MiniJinja](https://github.com/mitsuhiko/minijinja), a Jinja2 implementation, through
its official `minijinja-js` WebAssembly binding. The package's README labels the binding
experimental, so quiet-choir pins its version exactly and uses it only through
`src/workflow/prompts/engine.ts`. The engine loads on the first render or check, not on
`import 'quiet-choir'`. The environment's settings are fixed:

| Setting                         | Value         | Effect                                                                 |
| ------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `undefinedBehavior`             | `strict`      | Reading a missing variable or attribute is an error                    |
| auto-escaping                   | none          | `<b>` renders as `<b>`; prompts are markdown, not HTML                 |
| `trimBlocks`, `lstripBlocks`    | `true`        | A line holding only a block tag leaves no blank line                   |
| `keepTrailingNewline`           | `false`       | One final newline is dropped, from every template, including fragments |
| `fuel`                          | 5,000,000     | A runaway loop fails with `OutOfFuel` in well under a second           |
| custom filters and globals      | none          | A render depends only on its parameters                                |
| `random`, `randrange`, `lipsum` | removed       | A template that uses one fails with an unknown filter or function      |
| date-time module, `pycompat`    | never enabled | No clock, and no Python-style methods such as `dict.items()`           |

The other built-in filters are available, such as `tojson`, `indent`, `trim`, `join`, `default`,
`upper` and `length`. MiniJinja's `tojson` escapes `<`, `>`, `&` and `'` as `<`-style sequences. The
output is still valid JSON. Under strict undefined, test an optional parameter with
`{% if name is defined %}` or `name | default('')`.

Rendered text is step identity. An engine upgrade or settings change that changes the output of an
existing template changes the identity of every step that uses it. `test/prompts.test.ts` pins
golden renders as a gate, like the schema-identity goldens. Do not run a formatter such as Prettier
over template directories, because reformatting changes the rendered text.

## Paths, includes and the root

- Template names are POSIX paths relative to the root. A target of `include`, `extends`, `import` or
  `from ... import` resolves relative to the file that contains it. From `_fragments/a.md`,
  `{% include "b.md" %}` names `_fragments/b.md`.
- Each target must be one string literal. A computed target (`{% include name %}`), a list, a
  concatenation and `ignore missing` are all refused. Literal targets keep a template's dependency
  set static.
- The loader refuses absolute paths, backslashes, NUL bytes and any path that normalizes outside the
  root. It also refuses a file whose real path is outside the root's real path, so a symlink cannot
  escape the root. A symlink that stays inside the root is followed.
- By convention, shared fragments live under `root/_fragments/`. A fragment sees its includer's
  context, including loop variables. It loses its own final newline, so leave a blank line after the
  `include` tag where the output needs one.

## Front matter

Front matter is reserved for a later descriptor format. A file whose first line is `---` must close
the block with another `---` line. Between the two lines, only blank lines and at most one
`description: <value>` line are allowed. The value is a plain scalar or a JSON double-quoted string,
and must be a nonempty string. Any other key, an unterminated block, or a value YAML would read as a
number, boolean, null or list is an `InvalidFrontMatter` error.

Nothing in front matter reaches the rendered text. The block is replaced by a comment that spans the
same lines, so engine line numbers still match the file. The entry's own `description` takes
precedence over the front matter's.

## Load-time checks

A workflow that lists prompt sets is checked before any effect: by `workflow validate`, by the
`workflow execute` preflight, by `list-defs`, and by `runWorkflow` before the body runs. All errors
from every entry and child are reported together. Each one names the prompt, its file and, where
known, the file and line of the problem. Checks fail when:

- the entry's file does not exist or does not parse, or a fragment does not parse;
- an `include`, `extends`, `import` or `from` target anywhere in the entry's closure is not one
  string literal, uses `ignore missing`, resolves outside the root, or does not exist;
- a tag in the entry or its closure names `random` as a filter, `randrange` or `lipsum`. The scan
  skips prose, `{# #}` comments, `{% raw %}` blocks and quoted strings;
- the entry reads a top-level variable that is not a key of its `params`;
- a dotted path such as `issue.titel` names a key missing from a plain `z.object` (best effort). The
  walk unwraps `optional`, `nullable`, `default` and `readonly`. It stops at arrays, records,
  unions, other schemas, and objects with a catchall or passthrough.

A `params` key that neither the entry nor anything it includes or extends reads is a warning, not an
error. Variables read only by imported macros do not count, since macros do not see the caller's
context. Fragments are not held to the schema, because a fragment may read its includer's loop
variables. A misspelled variable in a fragment is therefore caught only at render, where strict
undefined still makes it a fatal `PromptError`.

`workflow validate --json` and `list-defs --json` publish the results as `prompts` on each node. The
field is `[]` when a node declares no prompt sets:

```json
{
  "prompts": [
    {
      "root": "/repo/review/prompts",
      "entries": [
        {
          "name": "Review",
          "file": "Review.md",
          "description": "Review a diff against the issue it claims to close.",
          "variables": ["diff", "issue", "threads"],
          "warnings": []
        }
      ]
    }
  ]
}
```

`validate` and `execute` also log each warning at `warn` level on stderr. The `list-defs` cache
treats every file under a declared prompt root as a source, including a file symlink (hashed through
its target), so editing a template or retargeting a link revalidates the entry without `--refresh`.

## Errors

Every parameter, template and engine failure throws a `PromptError`. Its message starts with
`Prompt <Name> (<file>)`, and it carries `prompt`, `file`, `kind` and `line`. Engine kinds are
passed through: `SyntaxError`, `UndefinedError`, `TemplateNotFound`, `OutOfFuel`, `UnknownFilter`,
`UnknownFunction` and others. quiet-choir adds its own kinds: `InvalidDefinition` for a
`definePrompts` argument, `InvalidParams`, `InvalidFrontMatter`, and `TemplateRefused` for a path
outside the root.

A render is not an effect. A `PromptError` is a fatal authoring error, recognized across module
instances like the other public errors
([ADR 0028](decisions/0028-brand-public-errors-across-module-instances.md)). Thrown in a workflow
body, a mapper of an `onError: 'return'` map, a settled child, or a `ctx.step` callback with `retry`
or `onError: 'return'`, it fails the run. It is never journaled as a settled item or step, and never
retried.
