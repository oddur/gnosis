# Markdown editor for review comments

Research date: October 28, 2026. Scope: compact comments, replies, comment edits, and review summaries in Gnosis. This is a recommendation, not an implementation.

## Recommendation

Use `@github/markdown-toolbar-element` with the existing textarea and a shadcn Write/Preview switch. Use one shared renderer for previews and posted comments.

This is the best fit for the current comment forms. It preserves Markdown source and requires fewer changes to existing draft handling. The package supplies formatting commands and toolbar focus management. Gnosis supplies the preview and visual styling. [GitHub README](https://github.com/github/markdown-toolbar-element)

If a complete React editor component is preferable, choose `@uiw/react-md-editor`. It is the strongest ready-made option for this use case. Its textarea, configurable commands, and custom preview callback fit the same approach. [uiw API](https://github.com/uiwjs/react-md-editor/blob/master/core/src/Types.ts)

## Why the existing code matters

Gnosis uses React 19, `react-markdown`, and `remark-gfm`. Comment drafts already contain Markdown strings. [Package manifest](../../package.json) [Comment composer](../../components/ChangesCommentComposer.tsx)

Several navigation guards locate an unfinished draft through `querySelector('textarea')`. A replacement editor without a textarea requires changes to those guards. [Diff guard](../../components/ReviewDiff.tsx) [Markdown guard](../../components/MarkdownReviewPreview.tsx) [Discussion guard](../../components/ReviewFileDiscussion.tsx)

The current comment renderer skips HTML and replaces images with attachment text. The shared `Markdown` component instead supports sanitized HTML, images, and diagrams. Preview consistency therefore requires a deliberate shared comment renderer. Reusing the general renderer alone does not match current comments. Neither configuration guarantees exact GitHub rendering. [Comment rendering](../../components/GitHubReviewThread.tsx) [General renderer](../../components/Markdown.tsx)

## Comparison

| Option | Relevant capabilities | Fit and cost |
| --- | --- | --- |
| **GitHub Markdown toolbar** | Formatting commands for a native textarea, including links, code, quotes, and task lists. Toolbar focus management. | Best minimal fit. Preview, React integration, and shadcn styling remain application work. It does not parse or render GFM. [README](https://github.com/github/markdown-toolbar-element) |
| **uiw React Markdown Editor** | Textarea source editor, GFM preview, automatic lists, custom commands, dark mode, and configurable preview. | Best complete editor component. Use Write/Preview tabs for narrow comment forms. Replace its preview with the shared comment renderer. [README](https://github.com/uiwjs/react-md-editor/blob/master/core/README.md) [API](https://github.com/uiwjs/react-md-editor/blob/master/core/src/Types.ts) |
| **MDXEditor** | Rich text through Lexical and MDAST conversion. Plugins include tables, task lists, strikethrough, code blocks, and source mode. | Prefer it if rich text becomes a product requirement. Conversion adds import/export behavior that needs representative Markdown checks. [Architecture](https://mdxeditor.dev/editor/docs/overview) [Dependencies](https://github.com/mdx-editor/editor/blob/main/package.json) |
| **Tiptap with `@tiptap/markdown`** | Extensible rich text, Markdown parsing into JSON, and serialization. Marked options include GFM. | Useful for a broader document editor. The official Markdown integration remains **Beta** and documents unsupported cases. [Markdown overview](https://tiptap.dev/docs/editor/markdown) [Configuration](https://tiptap.dev/docs/editor/markdown/getting-started/installation) |
| **CodeMirror 6** | Source editing, Markdown highlighting, list continuation, and parser extensions. | Best upgrade if comments need stronger source-editing behavior. Toolbar, preview, React lifecycle, and draft integration remain application work. [Language package](https://github.com/codemirror/lang-markdown) |

## Fidelity and extensibility

Textarea editing avoids a Markdown-to-document-to-Markdown conversion. That makes the toolbar and uiw the simplest choices for preserving source outside deliberate edits. CodeMirror also edits source, but adds an editor state model and integration work.

MDXEditor accepts and emits Markdown, but its rich-text mode converts between syntax trees. Its documentation describes import errors from missing plugins and some HTML-like syntax. Its source mode provides recovery. Source-to-diff switches preserve raw text, but that does not establish lossless rich-text round trips. [Architecture](https://mdxeditor.dev/editor/docs/overview) [Errors](https://mdxeditor.dev/editor/docs/error-handling) [Source mode](https://mdxeditor.dev/editor/docs/diff-source)

Tiptap supports custom parse/render handlers and tokenizers. Its documentation limits Markdown tables to one child node per cell. It also warns about document comment annotations during Markdown replacement. Those annotations differ from ordinary GitHub comment bodies. JSON conversion and configurable serialization do not establish exact source preservation. [Markdown overview](https://tiptap.dev/docs/editor/markdown) [Serialization configuration](https://tiptap.dev/docs/editor/markdown/getting-started/installation)

CodeMirror's `markdown()` defaults to CommonMark. Its `markdownLanguage` adds GFM plus other syntax. A GFM-only configuration can use the CommonMark base with GFM extensions. Syntax highlighting still requires a separate preview renderer. [Language implementation](https://github.com/codemirror/lang-markdown/blob/main/src/markdown.ts) [Package API](https://github.com/codemirror/lang-markdown)

## Compatibility, licensing, and performance

The inspected uiw, MDXEditor, and Tiptap React manifests include React 19 in their peer ranges. This is metadata evidence, not a completed Electron integration check. GitHub's toolbar and CodeMirror are browser components without a React peer requirement. [uiw manifest](https://github.com/uiwjs/react-md-editor/blob/master/core/package.json) [MDXEditor manifest](https://github.com/mdx-editor/editor/blob/main/package.json) [Tiptap React manifest](https://github.com/ueberdosis/tiptap/blob/main/packages/react/package.json)

All five reviewed open-source packages use MIT licenses. This statement covers the editor packages, not every optional commercial Tiptap service. [GitHub](https://github.com/github/markdown-toolbar-element/blob/main/package.json) [uiw](https://github.com/uiwjs/react-md-editor/blob/master/core/package.json) [MDXEditor](https://github.com/mdx-editor/editor/blob/main/package.json) [Tiptap Markdown](https://github.com/ueberdosis/tiptap/blob/main/packages/markdown/package.json) [CodeMirror](https://github.com/codemirror/lang-markdown/blob/main/package.json)

No bundle or latency benchmark was performed. uiw provides a `nohighlight` entry that omits its Prism highlighting dependency. Its default preview processes raw HTML, so renderer reuse also avoids different HTML policies. Dependency lists alone cannot establish runtime performance. [uiw README](https://github.com/uiwjs/react-md-editor/blob/master/core/README.md) [Preview implementation](https://github.com/uiwjs/react-markdown-preview/blob/master/core/src/index.tsx)

Before adoption, the useful checks are draft retention, undo, selection, IME input, keyboard submission, and preview consistency. Representative content includes task lists, tables, fenced suggestions, nested lists, links, HTML, and incomplete Markdown. Check mount cost and typing latency in the packaged Electron app. No package was installed for this research.
