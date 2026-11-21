import javascriptTags from '../src/assets/tree-sitter/javascript-tags.scm?raw';
import typescriptTags from '../src/assets/tree-sitter/typescript-tags.scm?raw';
import rustTags from '../src/assets/tree-sitter/rust-tags.scm?raw';
import goTags from '../src/assets/tree-sitter/go-tags.scm?raw';
import pythonTags from '../src/assets/tree-sitter/python-tags.scm?raw';
import javaTags from '../src/assets/tree-sitter/java-tags.scm?raw';
import csharpTags from '../src/assets/tree-sitter/csharp-tags.scm?raw';

/**
 * The grammar packages' `tags.scm` queries, bundled into each tree-sitter worker: the renderer's syntax worker
 * (lib/syntax-scope.worker.ts) and the main process's conflict checks (src/conflict-check-worker.ts).
 */
export const TAGS: Record<string, string> = {
  javascript: javascriptTags,
  typescript: typescriptTags,
  rust: rustTags,
  go: goTags,
  python: pythonTags,
  java: javaTags,
  csharp: csharpTags,
};
