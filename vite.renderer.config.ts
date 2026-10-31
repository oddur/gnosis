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
  optimizeDeps: {
    include: [
      '@base-ui/react/toast',
      '@pierre/diffs',
      '@pierre/diffs/react',
      '@pierre/diffs/edit',
      'shiki',
      'shiki/langs',
      'shiki/themes',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
