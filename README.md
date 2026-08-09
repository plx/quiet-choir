# quiet-choir

Harness-agnostic dynamic workflows for agents.

**Status:** This project is at the CLI spike stage. The package is intentionally private and
versioned `0.0.0` until its workflow contracts and release policy are ready.

## Direction

`quiet-choir` is intended to provide reusable workflow definitions and orchestration without tying a
workflow to a particular coding-agent harness, model provider, or execution environment.

The initial repository establishes the engineering baseline: strict TypeScript, ESM, tests and
coverage, linting, formatting, package validation, generated API documentation, and CI. Product APIs
will be added incrementally rather than guessed up front.

## Requirements

- Node.js 24 LTS is the recommended development runtime. CI also verifies the minimum Node.js 22.13
  release and the current even-numbered Node.js 26 line; odd-numbered releases are not supported.
- npm 10.9 or newer.
- [`just`](https://just.systems/) is optional; every recipe delegates to an npm script.

## Setup

```sh
nvm use
npm ci
npm run check
```

Conductor workspaces run `npm ci` automatically and expose test and TypeScript watch tasks.

## CLI spike

Run the TypeScript sources directly while developing:

```sh
npm run cli:dev -- --help
npm run cli:dev -- workflow typecheck ./path/to/workflow.ts
```

Or run the compiled launcher after `npm run build`:

```sh
npm run cli -- workflow typecheck ./path/to/workflow.ts
```

The initial oclif command tree is:

```text
quiet-choir
├── workflow
│   ├── execute       (placeholder)
│   ├── validate      (placeholder)
│   └── typecheck     Type-check a TypeScript workflow
├── configuration
│   ├── doctor        (placeholder)
│   ├── get           (placeholder)
│   └── set           (placeholder)
└── info
    └── version       Show the running package version
```

Placeholder commands print their status and exit with code 2 so scripts do not mistake them for
successful implementations.

Every command inherits `--log-level trace|debug|info|warn|error|fatal|silent` (default `info`) and
`-v, --verbose`, which selects `trace`. The two flags are mutually exclusive. Because oclif selects
the command before parsing inherited flags, place them after the complete command name:
`quiet-choir workflow execute --verbose`.

`workflow typecheck` requires an existing `.ts`, `.tsx`, `.mts`, or `.cts` file. It applies the
closest `tsconfig.json`, but replaces that config's roots with the requested entrypoint so imported
dependencies and configured ambient declaration files are checked without reporting unrelated
implementation files. Declaration files cannot be workflow entrypoints. It always disables emit and
forces semantic checking. Without a `tsconfig.json`, it uses strict ES2023/NodeNext defaults and the
Node 22 declarations matching quiet-choir's minimum supported runtime. Results identify the embedded
compiler version.

## Common commands

| npm                     | just              | Purpose                                  |
| ----------------------- | ----------------- | ---------------------------------------- |
| `npm run dev`           | `just dev`        | Rebuild TypeScript on changes            |
| `npm run cli:dev -- …`  | —                 | Run the CLI directly from TypeScript     |
| `npm run cli -- …`      | —                 | Run the compiled CLI                     |
| `npm test`              | `just test`       | Run tests once                           |
| `npm run test:watch`    | `just test-watch` | Run tests interactively                  |
| `npm run test:coverage` | `just coverage`   | Run tests with coverage gates            |
| `npm run format`        | `just format`     | Format source and configuration          |
| `npm run lint`          | `just lint`       | Run type-aware lint rules                |
| `npm run typecheck`     | `just typecheck`  | Type-check without emitting              |
| `npm run build`         | `just build`      | Emit ESM, declarations, and source maps  |
| `npm run docs`          | `just docs`       | Generate the TypeDoc site in `docs/api/` |
| `npm run check`         | `just check`      | Reproduce all required CI checks         |

## Project structure

```text
src/                 Production TypeScript and the public package entry point
test/                Behavior-focused Vitest tests
docs/                Hand-written guides and generated API documentation
.github/workflows/   CI, dependency review, and documentation deployment
.conductor/          Shared Conductor workspace scripts
```

See [Architecture](docs/architecture.md) for dependency-direction and documentation conventions.
Durable cross-cutting choices are recorded in
[architecture decision records](docs/decisions/README.md).

The spike deliberately does not implement layered `.quiet-choir` settings. Oclif exposes a
platform-specific user configuration directory, but it does not provide recursive project settings
discovery or closest-wins merging. That application-level resolver will be designed separately when
its schema and precedence rules are known.

## Documentation

Public exports should have TypeDoc-compatible doc comments and be re-exported from `src/index.ts`.
`npm run docs:check` treats broken links and undocumented public APIs as validation failures.
Changes merged to `main` are built and published by the GitHub Pages workflow after the repository's
Pages source is set to **GitHub Actions**.

## One-time repository settings

After this scaffold reaches `main`:

1. Set GitHub Pages to use **GitHub Actions** as its source.
2. Enable Dependabot alerts, Dependabot security updates, and private vulnerability reporting.
3. Protect `main` with pull requests and the CI, dependency-review, and CodeQL checks required.

CodeQL is configured by `.github/workflows/codeql.yml`; do not also enable CodeQL default setup.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Please report vulnerabilities
using the process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
