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
step that forces their content to match. Review both when runtime behavior changes, but allow
host-specific skill structure and instructions to diverge. Each skill bundles references for
setup/CLI, authoring, Claude, Codex, durability, inspection, and extensions.

For validation, run:

```sh
claude plugin validate .
claude plugin validate ./plugins/claude/quiet-choir
npm run check
```

Also validate the portable manifest against its declared JSON Schema and check that each marketplace
source and skill-relative reference resolves within its package. `npm run check` covers repository
checks but does not validate plugin schemas or reference links. The older Codex
compatibility-manifest validator expects `.codex-plugin/plugin.json` and is not a validator for this
portable format. No live harness call is needed to validate documentation packaging.
