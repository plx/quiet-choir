# Distributed agent documentation

The Claude and general-agent plugin trees are independent deliverables, even when their text is
identical. Keep physical copies, not symlinks or a shared generated source: their harness
conventions are expected to diverge. Consider both copies when the runtime contract changes.

Each installed plugin must stand alone. Bundle operational references inside its skill and use
skill-relative links; repository-relative links outside the plugin break after installation. The
plugins teach quiet-choir usage but do not install or contain the TypeScript runtime.

The general-agent package uses root `plugin.json` with the Agent Plugins schema; the Claude package
uses `.claude-plugin/plugin.json`. Marketplace paths resolve from the repository root. See
[docs/plugins.md](../docs/plugins.md) for installation and validation.
