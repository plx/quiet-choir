set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Show available development tasks.
default:
    @just --list

# Install exactly what is recorded in package-lock.json.
install:
    npm ci

# Run all local quality gates.
check:
    npm run check

# Format supported source and configuration files.
format:
    npm run format

# Check formatting without changing files.
format-check:
    npm run format:check

# Lint the project.
lint:
    npm run lint

# Type-check without emitting build output.
typecheck:
    npm run typecheck

# Run the test suite once; extra arguments are passed to Vitest.
test *args:
    npm test -- {{args}}

# Run tests in watch mode.
test-watch:
    npm run test:watch

# Run tests and enforce coverage thresholds.
coverage:
    npm run test:coverage

# Compile JavaScript, declarations, and source maps into dist/.
build:
    npm run build

# Recompile whenever a source file changes.
dev:
    npm run dev

# Generate the API documentation site in docs/api/.
docs:
    npm run docs

# Validate API documentation without writing generated files.
docs-check:
    npm run docs:check

# Validate the built npm package and declaration resolution.
package-check:
    npm run build
    npm run package:check

# Reproduce every CI validation locally.
ci:
    npm run ci

# Remove generated output.
clean:
    npm run clean
