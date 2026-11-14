import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/** The dev server injects an inline client script, which the panel's strict CSP would block. Builds keep it. */
const devWithoutCsp: Plugin = {
  name: 'menubar-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, ''),
};

/** The menu bar panel (#308): its own small renderer, outside the main window's bundle. */
export default defineConfig({
  base: './',
  cacheDir: path.resolve(
    __dirname,
    'node_modules/.vite-gnosis',
    createHash('sha256').update(`${__dirname}:menubar`).digest('hex').slice(0, 16)
  ),
  plugins: [react(), tailwindcss(), devWithoutCsp],
  build: {
    // Fonts stay files: the CSP allows font-src 'self', not data: URLs.
    assetsInlineLimit: 0,
    rollupOptions: { input: path.resolve(__dirname, 'menubar.html') },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
