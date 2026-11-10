set dotenv-load

js_files := "src tests examples package.json tsconfig.json tsconfig.test.json biome.json"

default:
    @just --list

# Compile JavaScript and TypeScript, and emit type declarations.
build:
    rm -rf dist
    tsc -p tsconfig.json

# Run an example under zpg. Extra arguments go to the example.
[positional-arguments]
run example="examples/demo.js" *args: build
    zpg node "$@"

# Run tests with the Node.js standard library. Extra arguments go to Node.
[positional-arguments]
test *args: build
    node --test "$@" tests/*.test.js

# Require the reference supervisor for compatibility tests.
compat: build
    ZPJS_REQUIRE_ZPG=1 node --test tests/zpg.test.js

# Measure statement and branch coverage.
coverage: build
    node --test --experimental-test-coverage tests/*.test.js

# Check that a TypeScript consumer can use the built package.
typecheck: build
    tsc -p tsconfig.test.json

lint-js:
    biome check {{ js_files }}

# Check the library without Git or network access.
check-js: lint-js typecheck test

lint: lint-js
    deadnix --fail flake.nix
    statix check .
    markdownlint README.md

typos:
    typos

fmt-check:
    biome format {{ js_files }}
    nixfmt --check flake.nix
    just --fmt --check

fmt:
    biome check --write {{ js_files }}
    nixfmt flake.nix
    just --fmt

# Run all hooks, including build, type, and test checks.
check: hooks

hooks:
    pre-commit run --all-files

# Run Node.js 22 checks and all hooks in the Nix build sandbox.
check-nix:
    nix flake check

# Build and inspect the npm package without publishing it.
pack: check-js
    npm pack --ignore-scripts

# Create a commit with a Conventional Commits message.
commit:
    cz commit
