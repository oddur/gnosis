# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Gnosis is a desktop application built with Electron, React, and TypeScript.

## Users

Software engineers review a high volume of incoming pull requests on their laptops.
They need to keep pace without losing their understanding of changes to the codebase.

## Product Purpose

Gnosis helps reviewers triage incoming work, understand its intent, and inspect the code that needs attention.
Success means less navigation and repeated reading, with enough evidence to make informed review decisions.

## Positioning

Gnosis explains changes in a useful order and connects explanations to source code and interactive diagrams.
A stack is a complete review subject, with its own purpose, explanation, and progress.
A standalone PR receives the same complete review experience.

## Operating Context

The primary workspace is a laptop window.
Reviewers move from an attention queue to a short briefing, then into a detailed review.
The queue includes requested reviews, updates since review, and dependencies that block other work.
Repository filters help reviewers narrow the queue.

## Capabilities and Constraints

The current application supports GitHub PRs, local Git reviews, saved reviews, chat, and interactive SVG explanations.
It supports Claude and Codex providers through their local tools.

The agreed workbench adds first-class stacks and a compact queue.
Clear dependency evidence groups PRs automatically. Uncertain relationships require user confirmation.
Users can correct grouping.

Short briefings run automatically within configurable usage limits.
Detailed walkthroughs and interactive explorations run on demand.
GitHub comments and approvals remain attached to individual PRs.

Explanation and code occupy the two main review panes.
Navigation can collapse. Chat and diagrams temporarily occupy a pane.
The application preserves review progress where source changes permit reliable matching.

## Brand Commitments

The name remains Gnosis. The voice is clear, calm, and direct.
The new direction replaces the newspaper metaphor with a compact review workbench.
Light and dark themes receive equal attention.

## Evidence on Hand

The agreed direction comes from the product discussion on October 22, 2026.
The current application and its tests provide the implementation baseline.
The workbench plan records acceptance criteria in `docs/review-workbench-plan.md`.

## Product Principles

- Preserve understanding while reducing the effort of review.
- Treat a stack as one coherent change, with traceable contributions from each PR.
- Give standalone PRs the same quality of explanation and review.
- Show the source and uncertainty behind generated guidance.
- Preserve the reviewer's place and attention across updates.

## Accessibility & Inclusion

All review actions support keyboard navigation with visible focus.
Meaningful text and controls meet WCAG AA contrast requirements.
Status uses labels or symbols as well as color.
Motion respects reduced-motion preferences.
