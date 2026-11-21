import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  base: './',
  // Worktrees can share node_modules, but must never replace another renderer's lazy chunks.
  cacheDir: path.resolve(
    __dirname,
    'node_modules/.vite-gnosis',
    createHash('sha256').update(__dirname).digest('hex').slice(0, 16)
  ),
  plugins: [react(), tailwindcss()],
  // Inline workers are classic scripts, so each must be one chunk. web-tree-sitter's Node-only `import('fs/promises')`
  // would otherwise split the syntax worker (#393).
  worker: { rollupOptions: { output: { inlineDynamicImports: true } } },
  optimizeDeps: {
    include: [
      '@base-ui/react/toast',
      '@pierre/diffs',
      '@pierre/diffs/react',
      '@pierre/diffs/edit',
      'shiki',
      'shiki/langs',
      'shiki/themes',
      // The syntax worker's runtime (#393): found late, it would reload the page mid-session.
      'web-tree-sitter',
    ],
  },
  build: {
    // The main process reads the tree-sitter wasm files from the package (src/main.ts): never inline them.
    assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
    rollupOptions: {
      output: {
        // The tree-sitter runtime and grammars keep their names, so the main process's conflict checks find them in the
        // package (src/main.ts, src/conflict-check-worker.ts). Everything else keeps Vite's hashed names.
        assetFileNames: (asset) =>
          asset.originalFileNames.some((name) =>
            /(^|\/)(src\/assets\/tree-sitter\/[\w-]+|web-tree-sitter\/web-tree-sitter)\.wasm$/.test(name)
          )
            ? 'assets/tree-sitter/[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
