# Prompt templates

Long prompts can live in markdown template files instead of template literals.
[ADR 0064](decisions/0064-prompt-templates-as-execution-dependencies.md) describes the design. A
TypeScript index declares each template with a Zod schema for its parameters. Each entry becomes a
plain, synchronous function that returns a `Prompt`. Before any effect, `workflow validate`, the
execute preflight, `list-defs` and `runWorkflow` check every template a workflow lists. Template
files are execution dependencies like the TypeScript sources, so a template edit is refused on
resume like a code edit ([below](#templates-as-execution-dependencies)), and agent records name the
template a call rendered ([records](#records)).

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
receive a string (`PromptText<O>` types their options). A roster stores a `Prompt` entry option as
its text too, so `roster.Reviewer.appendSystemPrompt` is typed `string`. Roster entries, `defaults`,
Codex options, native subagent `agents` and `ctx.ask` still take strings; use `.text` there.

## Template language and fixed settings

Templates use [MiniJinja](https://github.com/mitsuhiko/minijinja), a Jinja2 implementation, through
its official `minijinja-js` WebAssembly binding. The package's README labels the binding
experimental, so quiet-choir pins its version exactly and uses it only through
`src/workflow/prompts/engine.ts`. The engine loads on the first render or check, not on
`import 'quiet-choir'`. The environment's settings are fixed:

| Setting                         | Value         | Effect                                                                                                                                |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `undefinedBehavior`             | `strict`      | Reading a missing variable or attribute is an error                                                                                   |
| auto-escaping                   | none          | `<b>` renders as `<b>`; prompts are markdown, not HTML                                                                                |
| `trimBlocks`, `lstripBlocks`    | `true`        | Removes the newline after every block tag and comment, and indentation before a tag that starts a line; see [Whitespace](#whitespace) |
| `keepTrailingNewline`           | `false`       | One final newline is dropped from the end of every template file, including fragments                                                 |
| `fuel`                          | 5,000,000     | A runaway loop fails with `OutOfFuel` in well under a second                                                                          |
| custom filters and globals      | none          | A render depends only on its parameters                                                                                               |
| `random`, `randrange`, `lipsum` | removed       | A template that uses one fails with an unknown filter or function                                                                     |
| date-time module, `pycompat`    | never enabled | No clock, and no Python-style methods such as `dict.items()`                                                                          |

The other built-in filters are available, such as `tojson`, `indent`, `trim`, `join`, `default`,
`upper` and `length`. MiniJinja's `tojson` escapes `<`, `>`, `&` and `'` as `\u003c`-style
sequences. The output is still valid JSON.

Strict undefined catches a missing key, not `null`. Test an omitted `.optional()` parameter with
`{% if name is defined %}` or `name | default('')`. A `.nullable()` parameter passed `null` prints
as `None`, MiniJinja's name for it. `default('x')` replaces only undefined, so
`{{ commit | default('unknown') }}` still prints `None`. Guard a nullable value with
`{% if commit is not none %}`, or write `commit or 'unknown'` or
`commit | default('unknown', true)`; those two also replace `''`, `0` and `false`. `tojson` prints
`null`.

Values print verbatim, so a `</items>` inside a value closes an `<items>` fence early. For data the
agent parses, write `{{ value | tojson(indent=2) }}`, the same layout as `std.exec.json` (from
`quiet-choir/std`) with `<`, `>`, `&` and `'` escaped. For prose, neutralize the closing tag with
the built-in `replace` filter: `{{ text | replace("</items", "<\\/items") }}`. Write the backslash
twice, because `\/` in a template string is a plain `/`. `std.exec.json`, and any string built from
it in code, is not escaped. A fence helps the agent tell data from instructions but is not a
security boundary, so also say in the prompt that the fenced text is data.

Rendered text is step identity. An engine upgrade or settings change that changes the output of an
existing template changes the identity of every step that uses it. `test/prompts.test.ts` pins
golden renders as a gate, like the schema-identity goldens. Do not run a formatter such as Prettier
over template directories, because reformatting changes the rendered text.

## Whitespace

`trimBlocks` removes the first newline after every `{% %}` tag and `{# #}` comment, whether it is
alone on its line or ends a line of text. `lstripBlocks` removes the spaces and tabs before a tag
that starts a line. So a line holding only tags vanishes: read a template as if its tag-only lines
were deleted. `{{ }}` expressions are never trimmed. `+%}` keeps the newline after a tag. `{%-` and
`-%}` strip all whitespace on that side, newlines and blank lines included.

The recipes below show a template, then its render. `test/prompts.test.ts` pins each render.

A compact list puts `for` and `endfor` on lines of their own:

```text
Acceptance criteria:
{% for c in criteria %}
- {{ c }}
{% endfor %}

After.
```

```text
Acceptance criteria:
- Download works
- Headers

After.
```

Blocks separated by blank lines end the loop body with a blank line:

```text
Intro paragraph.

{% for e in evidence %}
<evidence>{{ e }}</evidence>

{% endfor %}
After.
```

```text
Intro paragraph.

<evidence>1</evidence>

<evidence>2</evidence>

After.
```

A conditional paragraph puts its blank line before `{% endif %}`, so both appear or vanish together:

```text
Intro.

{% if extra %}
Optional paragraph.

{% endif %}
After.
```

```text
Intro.

Optional paragraph.

After.
```

When `extra` is false, the render is `Intro.`, a blank line and `After.`.

A tag that ends a line of text eats that line's newline. End it with `+%}`:

```text
Location: {{ file }}{% if line %}:{{ line }}{% endif +%}
Evidence: {{ evidence }}
```

```text
Location: a.ts:5
Evidence: x
```

With a plain `{% endif %}` the render is `Location: a.ts:5Evidence: x`, and `A{# note #}` followed
by a line `B` renders `AB`. An inline expression has no tag to trim, so prefer `{{ a if c else b }}`
to a one-line `{% if %}`:

```text
Dims: {{ dims | join(', ') if dims else 'none' }}

Next paragraph.
```

```text
Dims: tests

Next paragraph.
```

The same line written `Dims: {% if dims %}{{ dims | join(', ') }}{% else %}none{% endif %}` loses
the blank line, and `Next paragraph.` follows on the next line.

An include line loses both the fragment's final newline and its own. Write
`{% include "_fragments/X.md" +%}` when the fragment file ends with a text line, so the include line
behaves like the fragment's lines pasted in. With `_fragments/note.md` holding the line
`Fragment paragraph.`:

```text
Intro.

{% include "_fragments/note.md" +%}

Next paragraph.
```

```text
Intro.

Fragment paragraph.

Next paragraph.
```

With a plain `%}`, `Next paragraph.` follows on the line after the fragment's, and without the blank
line it joins the fragment's line: `Fragment paragraph.Next paragraph.`. Inside a loop, the same
form gives a compact list of fragments. With `_fragments/thread.md` holding `- {{ t }}`:

```text
## Threads

{% for t in threads %}
{% include "_fragments/thread.md" +%}
{% endfor %}

## Next
```

```text
## Threads

- a
- b

## Next
```

A fragment whose last line is a block tag, such as `{% endfor %}`, already ends with its last text
line's newline, so include it without `+`. With `_fragments/criteria.md` holding the compact list
above, from `Acceptance criteria:` to `{% endfor %}`:

```text
Intro.

{% include "_fragments/criteria.md" %}

Next.
```

```text
Intro.

Acceptance criteria:
- Download works
- Headers

Next.
```

With `+%}` there, two blank lines precede `Next.`.

Prefer tag-only lines to `{%-` and `-%}`. A dash also strips the newlines and blank lines on its
side, so this loop glues every item to the line before it:

```text
Acceptance criteria:
{%- for c in criteria %}
- {{ c }}
{%- endfor %}
```

```text
Acceptance criteria:- Download works- Headers
```

## Paths, includes and the root

- Template names are POSIX paths relative to the root. A target of `include`, `extends`, `import` or
  `from ... import` resolves relative to the file that contains it. From `_fragments/a.md`,
  `{% include "b.md" %}` names `_fragments/b.md`.
- Each target must be one string literal. A computed target (`{% include name %}`), a list, a
  concatenation and `ignore missing` are all refused. Literal targets keep a template's dependency
  set static. The checks decode the literal's escapes as MiniJinja does before checking the path, so
  `"it\'s.md"` names `it's.md`, and a malformed escape is an error.
- The loader refuses absolute paths, backslashes, NUL bytes and any path that normalizes outside the
  root. It also refuses a file whose real path is outside the root's real path, so a symlink cannot
  escape the root, and a path through a directory symlink that leaves the root or loops back to an
  ancestor directory (such as `sub/up/A.md` with `sub/up -> ..`), which the fingerprint walk below
  skips. Any other symlink that stays inside the root is followed.
- By convention, shared fragments live under `root/_fragments/`. A fragment sees its includer's
  context, including loop variables. Its include line loses both the fragment's final newline and
  its own; see [Whitespace](#whitespace) for `+%}`.

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

A `params` key that neither the entry nor anything it includes, extends or imports reads is a
warning, not an error. A `params` key named like an engine global (`range`, `dict`, `namespace`)
shadows it, and reading it counts as reading the key. Variables read inside imported macros count:
MiniJinja gives a macro the render's context whatever the `import` or `from` tag's context clause
says. Fragments are not held to the schema, because a fragment may read its includer's loop
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

`variables` lists, sorted, the top-level variables the entry file itself reads: the set held to
`params`. What its includes, extends parent and imported macros read is not listed. It shows only as
the absence of an unused-parameter warning for those keys.

`validate` and `execute` also log each warning at `warn` level on stderr. The `list-defs` cache
treats every file under a declared prompt root as a source, including a file symlink (hashed by its
target's real path and contents) and the files under a directory symlink that stays inside the root
and does not loop back to an ancestor directory (listed at the path a render reads), so editing a
template or retargeting a link, even to identical contents, revalidates the entry without
`--refresh`.

## Templates as execution dependencies

ADR 0064 §4 makes every regular file under each declared prompt root part of the workflow's source
fingerprint, beside the TypeScript sources and with the same rules
([ADR 0006](decisions/0006-code-change-recovery.md)). The CLI hashes them after importing the
workflow, so `workflow validate --json` (`workflow.identity.files`), `workflow check-resume` and
`workflow execute` report one identity, and the run's `launch.sources` lists the templates too.

- **The whole root counts.** Every file under the root is hashed, whether or not a template
  currently includes it: an unused fragment, a draft and a file that is not markdown all count.
  Because dependency targets are literal and confined to the root, that set covers every file a
  render can read. Nothing is excluded, not even a root under `node_modules`.
- **Keys.** A file is keyed by its root's real path joined with its path inside the root, relative
  to the project root (the directory of the nearest `package.json` or the selected tsconfig), such
  as `prompts/Review.md` or `prompts/_fragments/header.md`. The value is the SHA-256 of the bytes a
  render reads, through any in-root link, so retargeting a link changes the hash under the link's
  own path. The walk skips a directory symlink that leaves the root or loops back to an ancestor
  directory, and the loader refuses any template path through one, so every file a render reads is
  hashed.
- **Resume.** A changed, added or removed file under a root is a code change: resume and
  `check-resume` refuse it with `Workflow code (prompts/Review.md) changed; ...` and list the path
  in the report's `files`. `--accept-code-change` waives the run-level check and records the files
  in `codeChanges`. A completed step that the resumed body renders again still fails its own
  fingerprint check when its rendered prompt changed, because the prompt text is step identity: the
  accepted-change preflight refuses with `Step <id>: prompt changed on a completed step` and the
  `--fork-from ... --invalidate <id>` command to run instead, and the run is left unchanged. An item
  of a committed `onError: 'return'` map and a settled child frame whose body ended replay their
  saved outcome without running the mapper or body, so their prompts are never rendered again: a
  template or fragment edit that only such items render is accepted under the flag and they keep the
  outputs of the old prompt; the run-level `codeChanges` entry still lists the file, with no map
  entry. To make such an edit refuse, bump the map's `version` (or the settled child's `version`,
  which a settled frame refuses to change) in the same edit; after a commit that means a fork. An
  edit that changes the prompt of no completed step the body re-renders, such as an unused fragment
  or a template only later steps render, resumes under the flag.
- **Forks** follow the same rules as code: a forked step reuses its result only when its own
  identity, including the rendered prompt, still matches.
- **Scope.** The roots are those of the static workflow tree: the root workflow's `prompts` and
  those of its declared `children`, recursively. A child known only at runtime (`ctx.workflow` given
  a definition outside the static tree) has its templates checked when it starts, but its prompt
  roots are not part of the launch fingerprint. An embedded `runWorkflow` caller supplies its own
  `source` and is not affected.

A workflow that declares no prompts keeps a byte-identical fingerprint. A run launched by an earlier
build from a workflow that declares prompts sees the template files as new entries once, so its
first resume needs `--accept-code-change`.

A template edit is now refused at launch like a code edit. To let a prompt vary without a
code-change acceptance, keep the varying text in parameters and the template stable.

## Records

When an agent call's `prompt` is a `Prompt`, its step and attempt request summaries record the
prompt name as `promptTemplate` (ADR 0064 §5), beside `promptSha256` and the 200-character
`promptPreview`. A string prompt records nothing, and so does a `Prompt` passed only as
`systemPrompt` or `appendSystemPrompt`. The field is observational, outside step identity
([ADR 0015](decisions/0015-observe-runs-without-changing-effect-identity.md)): a `Prompt` and the
equal string still share one fingerprint, and replay keeps the saved summary. Records before schema
revision 20 have no field.

`workflow inspect` prints `template <Name>` on agent lines and on the step-list line of a listed
agent step; `inspect --json` carries `request.promptTemplate` on the step and each attempt, and the
summary's agent rows (`agents.recent[]`) carry `promptTemplate`. An embedder's `onEvent` sees
`promptTemplate` on `agent.finished` for both completed and failed attempts. The compact `--events`
lines do not change.

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
