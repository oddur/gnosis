# Open in Gnosis: build from source

This archive is the source of the Open in Gnosis browser extension. The scripts in the store package are
bundled from TypeScript with esbuild. They are not minified or obfuscated.

## Requirements

- Node.js 20 or later and npm
- macOS, Linux or Windows

## Build

From the folder that contains this file:

```bash
npm install
npm run build:extension
```

The build writes:

- `dist-extension/firefox/`: the unpacked Firefox add-on. Its files are the same as the uploaded package.
- `dist-extension/open-in-gnosis-firefox-<version>.zip`: the Firefox package.
- `dist-extension/chrome/` and `dist-extension/open-in-gnosis-chrome-<version>.zip`: the Chrome and Edge package.

`package.json` pins the exact versions of the three build tools (esbuild, tsx and adm-zip), so the
output is byte-identical to the uploaded package.

## Where things are

- `extensions/browser/src/content.ts`: the content script on github.com. It adds the button.
- `extensions/browser/src/inject.ts`: the button, the hint and the page-change handling.
- `extensions/browser/src/link.ts`: builds the `gnosis://open?url=...` link from the page address.
- `extensions/browser/src/background.ts`: the toolbar action.
- `extensions/browser/manifest.ts`: the manifest source. `build.ts` writes one manifest for each browser.

The full project is at https://github.com/oddur/gnosis (folder `extensions/browser`).
