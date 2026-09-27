# Agent marketplaces

This repository is a marketplace for both Claude Code and Codex, with one `quiet-choir` plugin in
each. Both plugins provide a reference skill for the prototype. They contain documentation only;
follow the [runtime setup](../README.md#try-it-without-an-agent-subscription) separately to execute
workflows. Installation does not run workflows or sign in to either harness.

| Host                   | Marketplace file                                                          | Plugin root                                                                              | Skill                                                                      |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codex / general agents | [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) | [`plugins/agents/quiet-choir`](../plugins/agents/quiet-choir/plugin.json)                | [`quiet-choir`](../plugins/agents/quiet-choir/skills/quiet-choir/SKILL.md) |
| Claude Code            | [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)   | [`plugins/claude/quiet-choir`](../plugins/claude/quiet-choir/.claude-plugin/plugin.json) | [`quiet-choir`](../plugins/claude/quiet-choir/skills/quiet-choir/SKILL.md) |

## Install from a checkout

Run these commands from this repository's root with the corresponding CLI installed.

Claude Code:

```sh
claude plugin marketplace add .
claude plugin install quiet-choir@quiet-choir
```

Start a new Claude session and use `/quiet-choir:quiet-choir`, or ask about quiet-choir workflows.
For temporary local development, `claude --plugin-dir ./plugins/claude/quiet-choir` loads the plugin
without registering a marketplace.

Codex:

```sh
codex plugin marketplace add .
codex plugin add quiet-choir@quiet-choir
```

Start a new Codex session and use `$quiet-choir`, or select the skill from the installed plugin.
Clients with the plugin browser can also install it from the `quiet-choir` marketplace there.

Once these files are merged into the default branch, either CLI's marketplace-add command can use
`plx/quiet-choir` instead of `.`. A local checkout lets you try unmerged changes immediately.

## Packaging and maintenance

The general-agent plugin uses a root `plugin.json` declaring the
[Agent Plugins 1.0.0 schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). Codex
presentation metadata is under `extensions.com.openai`; skills are discovered from `skills/`. See
the [OpenAI packaging guide](https://developers.openai.com/plugins/build/plugins).

The Claude package has its own `.claude-plugin/plugin.json` and skill tree. See
[Claude marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces) and
[manifest reference](https://code.claude.com/docs/en/plugins-reference). Both catalogs resolve local
plugin paths from the repository root, not the catalog's hidden directory.

Keep the two packages physically independent: no symlinks, cross-package references, or generation
step that forces their content to match. Review both when runtime behavior changes. Task routes now
cover cross-project setup, background operation, triage, authoring, shared agent controls, provider
protocols, rehearsal, durability, and embedding.

Host-specific instructions can diverge inside named `skills-difference` regions. Each region needs
an exact file/region/reason entry in [the allowlist](../plugins/skill-differences.json), and both
copies retain its markers (the general copy can leave the region empty). The checker rejects
unknown, malformed, duplicate, or unused rules and all other byte/file-list differences. Review the
allowlist with the prose change; it is not a whole-file exception or a synchronization mechanism.

Run offline validation and the documented recipes with:

```sh
npm run skills:check
npm run build
node test/skills-cli-smoke.mjs
```

`npm run check` includes all three stages, and CI runs them in Quality and package. The skill check:

- Parses YAML frontmatter and validates both documentation-plugin manifests. The portable schema's
  normative validation keywords are pinned from Agent Plugins 1.0.0; Claude's schema explicitly
  covers this repository's documentation-only manifest fields. It also checks marketplace paths.
- Rejects symlinks and verifies Markdown links/anchors stay inside their physical installed package.
  External URLs are syntax-checked; validation does not depend on network availability.
- Compares the physical skill trees against the narrow difference allowlist.
- Compiles every complete `ts`/`typescript` fence from both copies against `src/index.ts`, with the
  repository's strict compiler options. Only recognized module import specifiers are redirected;
  example code and prompt strings are preserved. Diagnostics name the Markdown file and line.

Precede a deliberately incomplete code fence with
`<!-- skills-check: fragment; reason: Explain the omitted surrounding context. -->`. Do not mark a
broken complete example as a fragment. Executable recipes use
`<!-- skills-check: example example-id -->`; the smoke test extracts those actual fences. It runs
the shell golden path and jq summary in throwaway Git projects outside the checkout, verifies the
projects stay clean, and executes logging/resume recipes with a fake harness and captured native
protocol bytes. No credentials or paid calls are needed. `jq`, Git, and a POSIX shell must be on
PATH for that smoke test (available on the CI Ubuntu runner).

Mutation tests prove rejection of broken TypeScript, both invalid manifests, a bad marketplace path,
dangling links/anchors, package escapes, unintended differences, malformed annotations, duplicate
frontmatter, and symlinked deliverables.

Host-side Claude packaging checks remain useful when its CLI is installed:

```sh
claude plugin validate .
claude plugin validate ./plugins/claude/quiet-choir
```

The older Codex compatibility-manifest validator expects `.codex-plugin/plugin.json` and is not a
validator for this portable format. No live harness call is needed for documentation packaging.
