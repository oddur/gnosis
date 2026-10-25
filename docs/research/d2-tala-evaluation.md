# D2 and TALA for Gnosis

Research date: 2026-10-25. This report uses primary sources and distinguishes released software from historical product documentation. No comparative rendering benchmark was performed for this report.

## Recommendation

**Build the requested D2/TALA prototype, then assess production adoption with a small comparison.** TALA is a credible candidate for architecture diagrams with containers and cross-connections. A long, mostly linear explanation is a weaker reason to migrate. TALA's author explicitly prefers Dagre or ELK for some long flowing graphs. [1]

The current licensing and browser situation is better than older descriptions suggest. D2 v0.9.0 includes open-source TALA in its native and JavaScript/WebAssembly builds. It needs no separate plugin or license key. [2] The main adoption question is now diagram quality and integration cost, rather than a proprietary runtime license.

For Gnosis, compactness must mean readable labels within the actual preview. A smaller SVG bounding box alone does not establish that benefit. A vertical chain remains tall if every stage occupies a separate row. This is a geometric constraint, not a measured defect in either engine. Shorter labels, grouped stages, and separate detail views remain useful with either engine.

## Current license, pricing, and redistribution

| Item | Current evidence | Consequence for Gnosis |
| --- | --- | --- |
| D2 and bundled TALA | D2 v0.9.0 uses MPL-2.0. TALA's tagged README explicitly applies the repository license to its runtime source. [3][4] | Commercial use and redistribution are permitted under the license conditions. |
| End-user license keys | The release removes the need for a TALA plugin or key. [2] | Gnosis users need no TALA account or subscription for this version. |
| Runtime price | MPL-2.0 section 2.1 grants a royalty-free license. [3] | No runtime royalty or per-user fee follows from this license. |
| Distribution duties | Sections 3.1–3.4 cover source availability, executable distribution, larger works, and notices. [3] | Distribute the license and notices, and tell recipients how to obtain the corresponding covered source. |
| Proprietary application code | Section 3.3 permits a larger work under different terms. Covered files retain MPL obligations. [3] | Separate Gnosis files do not automatically become MPL-covered because the app includes D2. |
| Third-party code | TALA retains applicable third-party notices and terms. [4] | The packaged dependency notices also need review before distribution. |

The historical `terrastruct/TALA` repository describes a different distribution. Its README calls TALA closed source, requires payment for commercial use, and describes evaluation watermarks. It also describes perpetual personal keys with 12 months of updates. Its license file contains only a reference to the former commercial website. [5][6]

Those historical descriptions do **not** establish permission to redistribute the old proprietary plugin inside an application. A personal commercial-use license does not establish an embedding grant. This report identifies no current numeric commercial price because the new bundled runtime uses MPL-2.0. The former product URL redirects to D2's website. [1][3][5]

The recommendation applies to the open-source runtime in D2 v0.9.0 and later compatible releases. It does not rely on a retroactive license change for old proprietary binaries.

## Offline execution and Electron integration

D2.js runs in browsers and Node through WebAssembly and workers. Its documented API accepts `layout: 'tala'` and returns SVG. The tagged JavaScript changelog identifies version 0.1.34 as the release with D2 v0.9.0 and bundled TALA. [7][8]

```js
import { D2 } from '@d2lang/d2';

const d2 = new D2();
const result = await d2.compile(source, { layout: 'tala' });
const svg = await d2.render(result.diagram, result.renderOptions);
await d2.dispose();
```

The current package documentation recommends `@d2lang/d2`. It documents browser and Node entry points, worker disposal, virtual files for imports, fonts, themes, padding, and SVG ID salts. [7][9] This provides a plausible local integration path for Electron without a native helper process. The follow-up prototype verified Vite bundling, worker startup, and local file:// rendering in sandboxed macOS Electron. Full cross-platform packaged applications remain untested; see [the prototype record](d2-prototype.md).

The native release also includes TALA. Its assets cover macOS and Linux on AMD64/ARM64, plus Windows on AMD64/ARM64. [2] A native helper is an alternative, with separate executable packaging and process management. It is not a requirement for TALA in the current release.

The TALA adapter runs seed attempts locally and accepts cancellation through a context. The embedding application owns the timeout policy. [4] The author also identifies the current playground as entirely client-side. [1] These sources establish local layout capability. They do not prove that every possible document avoids network access. An offline app must package its runtime assets and control external icons and document resources.

At the start of this research, Gnosis imported Mermaid locally and displayed its SVG in a preview with an expanded viewport. [10][11][12] The package declaration specified `mermaid: ^11.12.3`. [13] The SVG display surface is reusable in principle. The generation prompt, `mermaidDiagram` fields, Markdown code fences, theme handling, and SVG ID handling also need migration decisions. [10][11][12][14][15] These local references describe the inspected baseline. The prototype can change these files.

## Architecture, icons, and annotated sequences

D2 supports sequence diagrams through `shape: sequence_diagram`. Actor and message declaration order determines their visual order. Activation spans use connections to nested actor objects. Unconnected nested actor objects become notes. Groups provide named frames around messages, but referenced actors must first exist at the sequence root. [24] These features support annotated call sequences without a separate language.

D2 supports icons from URLs and standalone images through `shape: image`. The CLI also accepts local image paths. [25] The browser path needs packaged or embedded assets for offline use. The CLI example does not establish browser filesystem support. Asset licensing is separate from the D2 runtime license.

D2.js documents animated SVG output through `animateInterval` and a multi-board `target`. [7] Steps inherit the previous step, while scenarios inherit the base layer. [26][27] These features support progressive explanations and alternative flows. They do not establish smooth motion between node positions or accessible playback controls. The prototype needs an explicit decision about playback, pause controls, and reduced motion.

Architecture layout and sequence layout serve different purposes. A sequence explicitly preserves message order, so additional messages increase its vertical extent. [24] TALA's architecture layout cannot remove that semantic constraint. A concise sequence with notes is a more useful prototype target than an exhaustive call trace.

## Layout strengths and limits

The project describes TALA as an orthogonal engine for software architecture diagrams. Its objectives include symmetry, distance, flow, and groups of similar nodes. [1] These are author claims about design goals, not proof that Gnosis diagrams become clearer.

The documented controls are relevant to architecture explanations:

- Containers and independent directions inside containers. [16][17]
- Fixed `top` and `left` positions, including layouts that mix fixed and automatic positions. [1][17]
- `near` relationships to other objects. [17]
- Dynamic edge-label placement and exact SQL-row connections. [16]

These controls can help distribute related parts across a landscape canvas. They also require meaningful structure in the generated source. Automatic layout cannot decide which implementation details deserve omission from a PR explanation.

The author documents three relevant tradeoffs. TALA can rearrange a whole diagram after a small input change. It can produce less suitable results for directed acyclic graphs. Runtime can grow nonlinearly for larger diagrams. [1] These statements support a comparison on Gnosis examples before migration.

TALA does not produce a different result on every identical render. The same input and seeds produce the same layout. The adapter selects the best candidate deterministically, with at most 16 distinct seed attempts. [1][4] The architecture document also permits geometry changes between releases. [18] A reproducible evaluation therefore needs fixed engine versions, fonts, seeds, and source.

The announcement includes seven real-world diagrams across TALA, Dagre, and ELK. The author supplies sources and rendering details. Each panel scales its SVG independently. [1] These examples illustrate differences, but their panel sizes cannot establish equal label readability or a Gnosis quality ranking.

## Maintenance

D2 v0.9.0 was released on September 7, 2026. [2] The current `d2lang/d2` repository remains active, with an observed main-branch commit on October 11, 2026. [19] The old `terrastruct/TALA` repository is archived. Its last standalone release is v0.4.3 from August 19, 2025. [20][21] The archived plugin repository does not represent current bundled TALA development.

The governance change deserves attention. The founder announced the closure of Terrastruct and D2's continuation through Hack Club fiscal sponsorship. He committed to maintenance with limited time and stated that D2 was no longer his primary focus. [22] Open source makes independent fixes possible, but this announcement does not promise a commercial support service or response time.

Some tour text remains historical. For example, the Dagre page says Mermaid exclusively uses Dagre and that Dagre development stopped in 2018. [23] This report does not use those statements to characterize current Mermaid. Release tags, package documentation, and the September 2026 announcements provide stronger evidence for the current D2 distribution.

## Hands-on follow-up

The requested prototype is implemented on `prototype/d2-tala-diagrams`. It renders local TALA architecture diagrams, native D2 sequences, icons, annotations, animated edges and controlled board playback. Browser checks covered both themes, narrow layouts, errors, real SlideView integration and the production file:// bundle. These are integration smoke checks, not a comparative benchmark or an evaluation of model-generated explanations. See [the prototype record](d2-prototype.md) for commands, evidence and limitations.

## Small comparison plan

The following procedure is proposed work. It is not a completed benchmark.

1. Collect six representative Gnosis diagrams, including the reported tall chain, a branching flow, and a nested architecture diagram.
2. Include cross-container connections, long labels, and a loop in the remaining examples.
3. Preserve the same nodes, edges, labels, and groups across the first comparison.
4. Compare current Mermaid with D2 Dagre, D2 ELK, and D2 TALA.
5. Add Mermaid with ELK if its current integration supports a small, isolated evaluation.
6. Render every result inside the actual Gnosis preview and expanded viewport.
7. Record the SVG dimensions, fit scale, visible label size, crossings, overlaps, and scroll distance at readable scale.
8. Record cold startup, warm rendering time, package overhead, and errors on the target Electron build.
9. Repeat identical inputs with fixed versions and seeds to assess determinism.
10. Change one label and one node to assess layout stability during explanation revisions.
11. Compare a second pass with shorter labels and grouped stages in both languages.
12. Adopt TALA only if representative diagrams improve without material readability, latency, or packaging regressions.

This separates engine benefits from better diagram content. A favorable result on architecture diagrams can justify selective D2 support before a complete replacement.

## Sources

1. [D2: TALA is open-source, September 7, 2026](https://d2lang.com/blog/tala-is-open-source/)
2. [D2 v0.9.0 release and native assets](https://github.com/d2lang/d2/releases/tag/v0.9.0)
3. [D2 v0.9.0 MPL-2.0 license](https://github.com/d2lang/d2/blob/v0.9.0/LICENSE.txt)
4. [Bundled TALA README at v0.9.0](https://github.com/d2lang/d2/blob/v0.9.0/d2layouts/d2talalayout/README.md)
5. [Historical proprietary TALA README](https://github.com/terrastruct/TALA/blob/master/README.md)
6. [Historical TALA license file](https://github.com/terrastruct/TALA/blob/master/LICENSE)
7. [D2.js README at v0.9.0](https://github.com/d2lang/d2/blob/v0.9.0/d2js/js/README.md)
8. [D2.js changelog at v0.9.0](https://github.com/d2lang/d2/blob/v0.9.0/d2js/js/CHANGELOG.md)
9. [D2.js package manifest at v0.9.0](https://github.com/d2lang/d2/blob/v0.9.0/d2js/js/package.json)
10. [Gnosis Mermaid renderer](../../lib/mermaid.ts)
11. [Gnosis diagram component](../../components/MermaidDiagram.tsx)
12. [Gnosis diagram viewport](../../components/MermaidViewport.tsx)
13. [Gnosis package manifest](../../package.json)
14. [Gnosis diagram generation guidance](../../lib/mermaid-guidance.ts)
15. [Gnosis explanation types](../../lib/types.ts)
16. [D2 TALA tour](https://d2lang.com/tour/tala/)
17. [D2 layout controls](https://d2lang.com/tour/layouts/)
18. [TALA architecture and determinism at v0.9.0](https://github.com/d2lang/d2/blob/v0.9.0/d2layouts/d2talalayout/ARCHITECTURE.md)
19. [D2 main-branch commit, October 11, 2026](https://github.com/d2lang/d2/commit/6a7b4837838a3907604a1d9eec57ee98b6f3cd01)
20. [Archived TALA repository metadata](https://api.github.com/repos/terrastruct/TALA)
21. [Historical TALA v0.4.3 release](https://github.com/terrastruct/TALA/releases/tag/v0.4.3)
22. [D2 is non-profit, September 5, 2026](https://d2lang.com/blog/d2-non-profit/)
23. [D2 Dagre tour](https://d2lang.com/tour/dagre/)
24. [D2 sequence diagrams](https://d2lang.com/tour/sequence-diagrams/)
25. [D2 icons and images](https://d2lang.com/tour/icons/)
26. [D2 steps](https://d2lang.com/tour/steps/)
27. [D2 scenarios](https://d2lang.com/tour/scenarios/)
