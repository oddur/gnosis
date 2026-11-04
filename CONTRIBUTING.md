# Contributing to Gnosis

## Prerequisites

Install these two tools (everything else is handled by devbox):

- [devbox](https://www.jetify.com/docs/devbox/installing_devbox/)
- [direnv](https://direnv.net/docs/installation.html)

## Getting started

```bash
git clone https://github.com/oddur/gnosis.git
cd gnosis
direnv allow   # one-time — activates devbox automatically on cd
task setup     # installs npm deps
```

After this, every time you `cd` into the repo, devbox activates and puts the correct versions of Node, task, pre-commit, and trufflehog on your PATH.

## What devbox provides

| Tool       | Version | Purpose                               |
| ---------- | ------- | ------------------------------------- |
| Node.js    | 20.x    | Matches Electron 34's bundled Node    |
| go-task    | latest  | Runs `Taskfile.yml` commands          |
| pre-commit | latest  | Git hook framework                    |
| trufflehog | latest  | Secret detection (used by pre-commit) |

## Available tasks

Run `task --list` to see all tasks. Key ones:

```
task setup          # Install npm deps
task dev            # Start Electron dev server
task lint           # Run ESLint
task lint:fix       # Run ESLint with auto-fix
task format         # Format code with Prettier
task format:check   # Check formatting
task package        # Package the app
task make           # Build distributable
```

## Pre-commit hooks (optional, encouraged)

Pre-commit hooks catch lint errors, formatting issues, and secrets before they reach the repo. They're optional but encouraged — CI runs the same checks, so setting them up locally saves you a round-trip.

### Setup

Devbox already puts `pre-commit` and `trufflehog` on your PATH. To install the git hooks:

```bash
task pre-commit:install
```

That's it. Hooks now run automatically on every `git commit`.

### What the hooks do

- **ESLint** — lints and auto-fixes JS/TS files
- **Prettier** — formats code on commit
- **TruffleHog** — blocks commits containing secrets
- **Trailing whitespace / end-of-file fixer** — enforces clean files
- **check-json / check-yaml** — validates config files
- **check-added-large-files** — prevents files over 1MB

### If a commit fails

Most hooks auto-fix the files for you. Just re-stage and commit again:

```bash
git add -u
git commit
```

### Run hooks manually

To run all hooks against all files (not just staged ones):

```bash
task pre-commit:run
```

## Browser checks

The Electron browser checks (`test:explainer`, `test:workbench`, `test:diagrams`) open real windows and take focus. To run them without touching your screen, use Docker. They then run under Xvfb on Linux, as in the Linux CI job:

```bash
npm run test:browser:docker                       # full suite, as on CI
npm run test:browser:docker -- --review-evidence  # a single workbench check
```

Set `GNOSIS_DOCKER_PLATFORM=linux/amd64` to match CI's architecture on Apple Silicon (slower, emulated).

## Code style

- ESLint and Prettier handle formatting — pre-commit fixes it on commit, or run `task format` and `task lint:fix` manually
