# D2/TALA diagram prototype

Question: can D2 produce clearer, richer explanations inside Gnosis, with useful architecture boundaries, icons, sequence annotations and intentional playback?

This is a throwaway evaluation on `prototype/d2-tala-diagrams`, built above the Mermaid workspace layer. It is not a decision to remove Mermaid from saved reviews or GitHub descriptions.

## Run

```sh
npm install
npm run prototype:d2
```

The command opens an isolated Electron window with three illustrative examples. It does not connect to GitHub, call a model, or access application data. Choose Architecture, Sequence, or Before & after. Expand a diagram to inspect annotations, zoom and pan. Use Play, Previous/Next, or Animate flow. The source editor lets you try your own self-contained D2.

The same component is wired into real explanation slides. Running the normal app from this branch (`npm start`) makes both new-review and topic-writer prompts generate `d2Diagram` instead of Mermaid. Existing saved Mermaid diagrams remain readable; regenerate an explanation to get new D2 output. D2 fences in Markdown also render.

## What works

- Local D2 0.9.0 / `@d2lang/d2` 0.1.34 with TALA, using the bundled WASM worker.
- Nested architecture containers and per-container directions.
- Seven bundled role icons: user, server, database, queue, cloud, shield, code. Write `icon: gnosis:database`, for example.
- Native sequence diagrams, notes, tooltips, animated edges, and top-level steps/scenarios.
- Explicit board playback with insightful captions; top-level steps inherit their predecessor, scenarios inherit the root.
- Fitted previews, expanded zoom/pan, accessible annotation text, theme-aware colors and reduced motion.
- Bounded in-memory render cache shared between instances, including the theme. SVG is sanitized, external resources are rejected, and a 20-second compile deadline terminates an overlong worker.
- Source inspection and error recovery. The gallery editor is in-memory only.

`d2Diagram` contains `source`, optional `caption`, and optional `steps` metadata (`title`, `description`) aligned to the root, then top-level native steps, then scenarios. Source and metadata persist as part of the existing saved-review format. Rendered SVG is currently cached only for the renderer session.

## Evidence and limits

All three examples rendered in Electron in both themes. Browser checks exercised fitted previews, data-URI icons, native board counts, previous/next/playback, expanded annotations, reduced motion, 1024px and 640px layouts, and invalid-source recovery. TypeScript and targeted lint pass. The production renderer bundle builds successfully and renders architecture and sequence examples through file:// in sandboxed macOS Electron. The real SlideView was also checked with an injected D2 example: its narrative diagram renders, the code diff remains visible, and expansion works.

The examples are authored demonstrations, not model-generated PR diagrams. No paid AI generation or private-code upload was performed. Prompt quality still needs evaluation against real reviews.

This prototype uses native D2 edge animation and application-controlled board playback. It does not implement smooth node morphing between arbitrary layouts. Top-level boards are supported; nested boards and arbitrary interactive code are not. Sequence diagrams use D2's specialized sequence layout; TALA handles the ordinary architecture graphs.

The browser engine contributes about 11.5 MB of uncompressed JavaScript to a separate lazy-loaded bundle. This is substantially smaller than the npm package's total unpacked size, which includes multiple platform distributions, but it is still a meaningful startup/memory tradeoff. Local caching avoids recompilation when revisiting a rendered diagram. Native-process rendering remains an alternative to investigate if cold-load costs prove noticeable.

A long sequence remains tall regardless of engine. The clearer example came from editing it down to the essential protocol, placing deeper context in annotations, and keeping the complete view expandable. TALA improves layout capabilities; it cannot replace editorial judgment.

The independent visual review approved the prototype after its narrow-screen switcher overlap was fixed. This is not a production-readiness verdict.

Before production adoption, evaluate generated syntax reliability, real PR explanation usefulness, larger-diagram latency/memory, source-linked annotations, and cross-platform packaged applications. Preserve the bundled license notices in `public/licenses/d2/` when distributing.

See [the source-backed research](d2-tala-evaluation.md) for licensing, maintenance, supported capabilities and the comparison plan.
