# SVG explanations

Mode: Operate / Read. This surface extends the existing Gnosis review workbench.

## Direction contract

THESIS: Choose the visual form that explains the code's difficult relationship, then generate that composition beside its supporting source.

OWN-WORLD: Preserve the typography, theme colors, compact controls, and subtle borders in [DESIGN.md](../../DESIGN.md). This extension introduces no global tokens.

STORY: Read the takeaway, inspect the visual relationship, and compare it with supporting code. Select a saved scenario or step through changes when the explanation benefits from those controls.

FIRST VIEWPORT: The illustration follows the explanation in the reading pane. Its takeaway, input assumptions, drawing, and caption stay together. Supporting code occupies the adjacent pane. Static illustrations omit playback controls.

FORM: The planner chooses a spatial representation for the reader's question; the writer checks it against the source before authoring the SVG. Geometry, shape, proportion, arrangement, and labels belong to that explanation. Do not force different code relationships into the same card layout or a catalog of node types. A static composition is valid. Use motion when following a change improves understanding. The saved artifact records the approach, rationale, visual encodings, and purpose of any motion.

INTERACTION: Gnosis owns shared controls and motion. Animated illustrations start paused and offer play, pause, previous/next step, scrub, restart, and speed. Complete SVG snapshots make backward navigation deterministic; stable object identities let the host move objects between saved positions. Expansion preserves the scenario and step. Closing expansion restores focus to its control. Reduced motion preserves snapshots without movement. Hiding the window pauses playback.

SCOPE: Scenarios choose finite saved illustrative cases with explicit inputs and assumptions. They do not execute source code or simulate arbitrary inputs. Playback does not measure execution time. Generated explanations require comparison with source; browser validation cannot prove their accuracy or explanatory quality.

## Implementation and evidence

[SvgIllustration](../../components/SvgIllustration.tsx) supplies the inline and expanded host, with [local styles](../../components/svg-illustration.css). [The artifact contract](../../lib/svg-illustration.ts) owns writer guidance. [The sandbox document](../../lib/svg-illustration-document.ts) accepts allowlisted SVG snapshots inside an opaque-origin iframe and runs shared Gnosis playback code. Generated scripts, event handlers, HTML, external resources, and model-owned animation are excluded. [SlideView](../../components/SlideView.tsx) connects resolved source evidence to the code pane.

[SVG explanation slides](../../docs/animated-svg-explanations.md) owns generation, storage, validation, and evaluation details. Generation validates all frames at a 440px pane width in both themes. A separate critic receives the source and labelled screenshots of states and transition midpoints. It can request one illustration-only repair, which is rendered and reviewed again. A failed or unavailable review omits the picture while preserving the narrative.

The earlier [MechanismDiagram](../../components/MechanismDiagram.tsx) player remains compatible with saved card-based mechanisms. The **Visual explanations** comparison gallery offers it as **Previous version** for the first two examples. Saved D2 and Mermaid diagrams and separate free-form explorations also remain supported.

This documentation pass inspected the current implementation, guide, and these fresh captures:

- [Ordered batching, light, 1000px](../../docs/images/svg-explanations/queue-light-1000-figure.png): two input cases show the queue-order constraint and oversized-first-item exception beside source.
- [Atomic version check, light, 1280px](../../docs/images/svg-explanations/version-light-1280-figure.png): two independent rows compare a rejected stale write with a successful update.
- [Array rotation, dark, 1280px](../../docs/images/svg-explanations/rotation-dark-1280-figure.png): successive array states show reversal ranges and preserve group identity with shapes.
- [Authored playback fixture, next step](../../docs/images/svg-explanations/motion-next.png): a stable object appears at position two with scenario selection and shared playback controls.

The first model outputs chose static compositions. The newer generation adds explicit animation briefs and rendered educational review. After user feedback, batching now uses separately selectable cases with proportional weights and a projected rejected addition. The stale-write example is a static comparison with directly aligned expected and stored versions; its earlier playback added no useful information. The user-approved rotation is unchanged. Evaluation artifacts and their contact sheets are in `docs/research/generated-illustrations/`. The older static outputs remain in its `static-baseline/` directory. The independently authored motion fixture covers playback, backward navigation, scenario switching, expansion, and reduced motion in browser checks.

FINISH: The finish reviewer accepted the surface within a two-fix scope: diagram strokes now use local `--line` values of `#7a8596` in light and `#69788f` in dark, meeting at least 3:1 against their backgrounds; the gallery is named **Visual explanations**. The mechanical detector reported no findings. This is an ordinary workbench extension with local diagram styling. This pass updates only this surface brief; DESIGN.md and its sidecar remain unchanged.
