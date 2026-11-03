# Gnosis

_Gnosis_ is an ancient Greek word for knowledge — not the surface kind, but the deep, direct understanding of something. The Gnostics used it to mean insight that comes from within, from truly comprehending a thing rather than just observing it from the outside. That's what's missing from most code reviews: you see the diff, but you don't get the understanding. Gnosis tries to close that gap — to give the reviewer not just the changes, but the story behind them.

We've gotten fast at writing code. Reviewing it hasn't kept up.

Pull requests are still reviewed the same way they always have been — scrolling through a list of file diffs in whatever order GitHub decides to show them, with no grouping, no context, and no sense of which changes depend on which. It works, but it's slow and it's easy to miss things.

Gnosis is an experiment in changing that. Paste a PR URL and it reads the diff, groups related changes together, and presents them as an ordered slideshow — foundation changes first, then the features built on top, then tests and config. Each slide has a short explanation of _why_ the change is there, the relevant diff, and optionally a diagram. The goal is to walk the reviewer through the change the way the author understands it, not the way the filesystem happens to order it.

It runs locally. AI features use the [Claude Code CLI](https://claude.ai/code) or [Codex CLI](https://learn.chatgpt.com/docs/cli).

## Features

- **Guided setup** — choose review goals, create saved views, and pick separate explanation and briefing models from installed Claude Code or Codex tools. Defaults are Opus/Sonnet for Claude and Sol/Terra for Codex. Preview your choices before applying them, pause setup, or replay it anytime.
- **Guided slideshow** — changes are grouped by theme and ordered by dependency (foundations first, then implementations, then tests and config), not by filename
- **Model choice** — use Claude or Codex for reviews, slide chat, and smart imports. Codex supports GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, and GPT-6 Luna. Terra requires Codex CLI 0.159.0 or later.
- **Deeper reasoning** — use more reasoning effort (slower, more thorough)
- **Custom instructions** — steer the review with free-text prompts (e.g. _focus on security_, _explain the auth flow_)
- **Inline review comments** — add comments on specific diff lines and submit directly to GitHub as an approval, request for changes, or comment
- **Local notes** — collect private notes on lines or regions while reviewing a stack (Combined or By PR) or a single PR, then copy them as Markdown for any agent. The export records the file, lines and view of each note and explains how you reviewed
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
- **D2 diagrams and walkthroughs** — explanations can include architecture maps, annotated sequences, algorithm states, and animated paths with step-by-step playback. Saved Mermaid diagrams remain readable. [Diagram generation and evaluation](docs/d2-explanations.md).
- **Interactive explanations** — select **Explore** on a slide to generate an animated SVG example. Step through an algorithm, adjust its inputs, and inspect the supporting code.
- **Risk assessment** — each review is rated low/medium/high risk based on what changed
- **Clickable file paths** — diff header file paths link directly to the file on GitHub
- **Configurable CLI paths** — if the CLI isn't auto-detected (e.g. Finder/Dock launch), set the path manually in Settings
- **Code appearance** — pick your code font and syntax theme in Settings
- **Auto-update** — automatically downloads and installs new releases; falls back to an in-app banner on platforms without auto-update support
- **Cross-platform** — builds for macOS, Windows, and Linux (deb/rpm)

## Requirements

You can browse PRs and inspect diffs without an AI CLI. Local reviews also work without GitHub sign-in.

For AI explanations, briefings, and chat, install and authenticate at least one CLI:

- [Claude Code CLI](https://claude.ai/code) 2.1.293 or later: run `claude update` to upgrade. Authenticate with `claude auth`.
- [Codex CLI](https://learn.chatgpt.com/docs/cli) 0.163.0 or later: install with `npm install -g @openai/codex`, then authenticate with `codex login`.

Claude offers Fable 5.1, Opus 5.5, Sonnet 5.5, and Haiku 5.5. Model access depends on your Claude account.

Codex uses its saved CLI login. Gnosis does not require a separate OpenAI API key.
Model access depends on your Codex account.

In the model menu, select a model under **Codex**.
If Gnosis cannot find the CLI, set **Codex CLI path** in Settings.

To pass environment variables to either tool, open **Settings → Integrations → AI environment variables**. Add name/value pairs for Claude or Codex, then save that tool's variables. New jobs use the saved overrides; running jobs keep their existing environment.

Values are masked by default and encrypted locally with the operating system's secure storage. Values are literal text: `$HOME` and shell commands are not expanded. An empty value is an explicit override. Remove a variable and save to restore its inherited value. Gnosis manages Claude's effort variables through its model and thinking settings.


Codex supports GitHub PRs, local Git diffs, background reviews, slide chat, and smart imports.
Codex reviews the context supplied by Gnosis in a read-only session.
Gnosis disables Codex shell tools, apps, plugins, hooks, and web search for these sessions.
Gnosis does not load user CLI settings or project instructions automatically.
The **Apply project's Claude conventions** option still adds those files to the supplied review context.
Web research, GitHub MCP, and local project tools require Claude.

**Deeper reasoning** selects high reasoning effort for Claude and Codex. With this option off, both providers use low effort.
Models can still reason at low effort. Slide chat and smart imports always request low effort.

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

## First launch and setup

Choose one or more goals in setup:

- **Review PRs assigned to me** creates **Needs my review** for review requests and PRs where you are an assignee.
- **Follow repository work** creates **Repository activity** across the repositories you choose.
- **Track my own PRs** creates **My PRs** for PRs you authored.

Your own PRs and review requests need no repository selection. **Use local reviews without GitHub** skips the GitHub and repository steps.

New installations include PRs updated within 30 days and hide Dependabot PRs. You can change these defaults and refine labels, authors, or target branches.

AI setup is optional. The tool check detects the CLI binary, but does not check authentication or model access.
Automatic briefings require opt-in and have a daily limit. Full explanations start only when you request them.

Review the preview, name your views, and choose which view opens first. Select **Apply setup** to save these choices.
Replay updates the views that setup created. It preserves other saved views, reviews, and drafts.

**Finish later** saves your progress. **Resume setup** continues from that point.
**Run setup again** and **Show walkthrough** are separate actions in Help, Settings, and the command palette (Cmd/Ctrl+K).

The walkthrough highlights the queue, PR summary, Changes, and Explanation. Local mode highlights **Local changes**.
You can close the walkthrough and resume it with **Show walkthrough**. After completion, the same action starts it again.
The walkthrough does not generate AI content or submit reviews.

## Usage

1. Paste a GitHub PR URL — or click **Browse** to pick from your open PRs and review requests
2. Choose a Claude or Codex model
3. Optionally enable **Deeper reasoning** for deeper analysis (slower)
4. Optionally add custom instructions — e.g. _focus on security_, _explain the auth flow_
5. Hit **Generate Review** — the review generates in the background so you can submit more PRs or browse existing reviews while it runs

Navigate slides with **← →** or the Prev/Next buttons. Drag the divider between the narrative and diff panels to resize.

Past reviews are saved locally and grouped by PR on the home screen — click any to reload without re-generating.

For suitable topics, **Explore** builds an interactive example when you request it. Generation uses your selected Claude or Codex model.

New explanations animate items between states during Play or Step. Pause freezes transitions; Reset returns to the initial state. Reduced-motion settings show state changes immediately. For a saved example, open **Details & refine → Add animated transitions** to generate a version with item movement.
Use **Play**, **Step**, and **Reset** to follow the example. Read its assumptions and select a source file to inspect the saved diff.
**Try another scenario** generates a refined version from your instructions. Explainers are saved with the review and included in exported review archives.
The examples illustrate code behavior. Their displayed timings are model inputs unless the supplied evidence establishes measured values.

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
