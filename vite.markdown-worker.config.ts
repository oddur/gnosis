import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// Markdown libraries expose DOM-based browser entry points. This worker has no DOM.
export default defineConfig({
  resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
  build: {
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
