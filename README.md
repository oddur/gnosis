# Gnosis

_Gnosis_ is an ancient Greek word for knowledge — not the surface kind, but the deep, direct understanding of something. The Gnostics used it to mean insight that comes from within, from truly comprehending a thing rather than just observing it from the outside. That's what's missing from most code reviews: you see the diff, but you don't get the understanding. Gnosis tries to close that gap — to give the reviewer not just the changes, but the story behind them.

We've gotten fast at writing code. Reviewing it hasn't kept up.

Pull requests are still reviewed the same way they always have been — scrolling through a list of file diffs in whatever order GitHub decides to show them, with no grouping, no context, and no sense of which changes depend on which. It works, but it's slow and it's easy to miss things.

Gnosis is an experiment in changing that. Paste a PR URL and it reads the diff, groups related changes together, and presents them as an ordered slideshow — foundation changes first, then the features built on top, then tests and config. Each slide has a short explanation of _why_ the change is there, the relevant diff, and optionally a diagram. The goal is to walk the reviewer through the change the way the author understands it, not the way the filesystem happens to order it.

It runs locally and uses the [Claude Code CLI](https://claude.ai/code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli) under the hood.

## Features

- **Guided slideshow** — changes are grouped by theme and ordered by dependency (foundations first, then implementations, then tests and config), not by filename
- **Multi-provider** — choose between Claude (Opus, Sonnet, Haiku) and Gemini (3.1 Pro, 3 Pro, 3 Flash, 2.5 Pro, 2.5 Flash)
- **Extended thinking** — enable deeper reasoning for Claude models (slower, more thorough)
- **Custom instructions** — steer the review with free-text prompts (e.g. _focus on security_, _explain the auth flow_)
- **Inline review comments** — add comments on specific diff lines and submit directly to GitHub as an approval, request for changes, or comment
- **Split diff view** — toggle between unified and side-by-side diff layout; preference persists across sessions
- **Slide chat** — ask follow-up questions about any slide in an inline resizable side panel, with tool call indicators shown as pills during streaming
- **Web research** — optionally allow the AI to search the web and fetch pages during review generation and slide chat (Claude only)
- **MCP tool support** — optionally allow the AI to query GitHub context (issues, PRs, file contents) during reviews via MCP (Claude only)
- **Signal boost** — filters out trivial changes (whitespace, import reordering, boilerplate) and focuses on design decisions, complexity, and API surface changes
- **Smart imports** — uses a fast model to detect local file imports across all languages (C#, Rust, Python, Go, etc.), giving reviewers context beyond just JS/TS `import` statements
- **PR browser** — browse your open PRs and review requests instead of pasting URLs
- **Stale review detection** — if a PR receives new commits after your review was generated, a banner shows what changed and offers to re-generate
- **Background generation** — reviews generate in the background with live phase indicators; submit multiple PRs and keep browsing while they run
- **Review history** — past reviews are saved locally and grouped by PR on the home screen
- **Clickable review checks** — click a "what to check" item to scroll directly to the relevant code in the diff
- **Large file filtering** — automatically detects and excludes large generated files (lockfiles, bundles) from the review to keep the AI focused on meaningful changes
- **Mermaid diagrams** — slides can include architecture and flow diagrams, viewable in fullscreen
- **Risk assessment** — each review is rated low/medium/high risk based on what changed
- **Clickable file paths** — diff header file paths link directly to the file on GitHub
- **Configurable CLI paths** — if the CLI isn't auto-detected (e.g. Finder/Dock launch), set the path manually in Settings
- **Code appearance** — pick your code font and syntax theme in Settings
- **Auto-update** — automatically downloads and installs new releases; falls back to an in-app banner on platforms without auto-update support
- **Cross-platform** — builds for macOS, Windows, and Linux (deb/rpm)

## Requirements

- **At least one** of the following CLIs installed and authenticated:
  - [Claude Code CLI](https://claude.ai/code) — authenticate with `claude auth`
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)

## Install

```bash
brew tap oddur/gnosis
brew install --cask gnosis
```

Or download manually from [GitHub Releases](https://github.com/oddur/gnosis/releases). The macOS build is code-signed and notarized.

## Update

```bash
brew update && brew upgrade --cask gnosis
```

On first launch, click **Sign in with GitHub** to authenticate via OAuth.

## Usage

1. Paste a GitHub PR URL — or click **Browse** to pick from your open PRs and review requests
2. Choose a provider (Claude or Gemini) and model
3. Optionally enable **Extended thinking** for deeper analysis (Claude only, slower)
4. Optionally add custom instructions — e.g. _focus on security_, _explain the auth flow_
5. Hit **Generate Review** — the review generates in the background so you can submit more PRs or browse existing reviews while it runs

Navigate slides with **← →** or the Prev/Next buttons. Drag the divider between the narrative and diff panels to resize.

Past reviews are saved locally and grouped by PR on the home screen — click any to reload without re-generating.

## Screenshots

<img width="1512" height="1012" alt="image" src="https://github.com/user-attachments/assets/3264f9b2-8595-4233-8e9c-f736238f7185" />

<img width="1512" height="1012" alt="image" src="https://github.com/user-attachments/assets/db3f28af-5a64-489f-b5d8-55fab109c103" />

<img width="1512" height="1012" alt="image" src="https://github.com/user-attachments/assets/f5e0f4aa-bf81-4817-a68d-a478f9030778" />
<img width="1512" height="1012" alt="image" src="https://github.com/user-attachments/assets/f83e2731-9e62-4072-9a84-ff1c6ca54c6c" />

## Development

Prerequisites: [devbox](https://www.jetify.com/docs/devbox/installing_devbox/) and [direnv](https://direnv.net/docs/installation.html).

```bash
git clone https://github.com/oddur/gnosis.git
cd gnosis
direnv allow   # activates devbox automatically on cd
task setup     # installs npm deps
task dev       # starts the Electron dev server
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## Build

```bash
task make      # produces a distributable in out/
```
