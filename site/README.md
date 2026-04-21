# gnosis.to

Marketing site for Gnosis. Astro + Tailwind v4. Deploys to GitHub Pages on push
to `main` whenever anything under `site/` changes (see `.github/workflows/site.yml`).

## Local dev

```bash
cd site
npm install
npm run dev          # http://localhost:4321
npm run build        # outputs site/dist
npm run preview      # preview the production build
```

## Style

Editorial tokens (warm OKLCH palette, Fraunces / Plus Jakarta / JetBrains Mono,
claret accent) are mirrored from `src/globals.css` of the app. Self-contained —
this folder doesn't import anything from the Electron source.

## Domain

`gnosis.to`. The `public/CNAME` file ships with each build so GitHub Pages keeps
the custom domain mapped.

DNS:
- `A` records on apex (`gnosis.to`) → `185.199.108.153`, `185.199.109.153`,
  `185.199.110.153`, `185.199.111.153`
- `CNAME` on `www.gnosis.to` → `oddur.github.io`
