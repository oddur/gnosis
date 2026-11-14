# Open in Gnosis (browser extension)

A small extension for Chrome, Edge and Firefox. It adds an **Open in Gnosis** button to GitHub pull request, commit and compare pages. The button opens the same page in the Gnosis app, on the same tab, file, line or thread where the app supports it (oddur/gnosis#310).

## What it does

- On `github.com`, the content script shows the button when the path is a pull request (`/<owner>/<repo>/pull/<n>…`, any tab), a commit (`/<owner>/<repo>/commit/<sha>`) or a compare view (`/<owner>/<repo>/compare/…`). It puts the button in the page header actions, or floats it in the bottom-right corner when the page has no header there (compare).
- On a click, it opens `gnosis://open?url=` + `encodeURIComponent(location.href)`, using the URL at the moment of the click. The extension does not parse the URL. The Gnosis app maps it (design section 3.4, `lib/deep-link.ts`), so a new GitHub URL shape is fixed in the app, not in the extension.
- If the link would be longer than 4096 characters, the extension drops the query (except `pr` and `check_run_id`), and then the fragment.
- It follows GitHub's client-side navigation (Turbo, history changes and React re-renders). There is never more than one button, and the button goes away when you leave a supported page.
- The toolbar icon does the same thing on a supported page. On other pages it is greyed out.
- **Gnosis not installed.** A web page cannot detect whether an app handles `gnosis://`. If the page still has focus 1.5 seconds after a click, the extension shows a small hint: "Gnosis didn't open. Get Gnosis →", with a link to the latest release. The × button hides the hint for good. This is a heuristic: if the browser shows its own "Open Gnosis?" prompt, the page loses focus and no hint is shown.

Links from the extension are not trusted by the app. They go through the same parser, rate limit and confirmation rules as any other link. The extension opens a link only when you click.

## What it accesses

| Permission | Why |
|---|---|
| Content script on `https://github.com/*` | Shows the button. It matches all of github.com because GitHub moves between pages without a page load (for example, from the pull request list into a pull request). The script itself does nothing outside pull request, commit and compare pages. |
| `storage` | Stores one value, `gnosisHintDismissed: true`, after you dismiss the "Gnosis didn't open" hint. |
| `activeTab` | Lets the toolbar action read the URL of the tab you clicked it on. |

It has no `tabs` permission, no host permissions beyond the content script match, and no network access. It makes no requests, uses no GitHub token, and stores no page data. Neither permission above shows an install warning. The browser shows "Read and change your data on github.com" for the content script.

### GitHub Enterprise

Not enabled. The app rejects Enterprise hosts today (`unsupported-host`, design 7.3). When the app allows them, add the hosts as optional permissions and request them at runtime from an options page, for example:

```json
"optional_host_permissions": ["https://github.example.com/*"]
```

The content script would then be registered for those hosts with `chrome.scripting.registerContentScripts`, which needs the `scripting` permission.

## Build

```bash
npm run build:extension
```

This writes:

- `dist-extension/chrome/` and `dist-extension/open-in-gnosis-chrome-<version>.zip` (Chrome and Edge)
- `dist-extension/firefox/` and `dist-extension/open-in-gnosis-firefox-<version>.xpi` (Firefox, unsigned)

The source is in `src/`. `manifest.ts` is the one manifest source; `build.ts` writes a variant for each browser (Chrome uses a background service worker; Firefox uses a background script and needs `browser_specific_settings.gecko`). The icons in `icons/` were made from `Icon/web/icon-512.png`.

For a build that opens the development app, set the scheme:

```bash
GNOSIS_SCHEME=gnosis-dev npm run build:extension
```

Lint the Firefox package (web-ext is not a dev dependency, because of its size):

```bash
npx --yes web-ext@8 lint --source-dir dist-extension/firefox
```

Tests: `tests/browser-extension-link.test.ts` and `tests/browser-extension-dom.test.ts`, run by `npm test`. The URL shapes are in `tests/fixtures/github-page-urls.json`, which the app's protocol tests also use.

CI (`.github/workflows/checks.yml`, job "Browser extension") builds both packages, lints the Firefox one, and uploads both as artifacts. It does not publish.

## Load it unpacked

Build first, then:

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist-extension/chrome`.
- **Edge:** open `edge://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist-extension/chrome`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and choose `dist-extension/firefox/manifest.json`. The add-on stays until Firefox restarts. If the button does not show, open `about:addons`, select the add-on, and on **Permissions** allow access to github.com.

After a rebuild, click the reload button on the extension card (Chrome, Edge) or **Reload** (Firefox), then reload the GitHub tab.

The first time a link opens, the browser asks whether to open Gnosis. Choose to always allow it for github.com.

## Publishing (to do by the owner)

Nothing here is automated. CI has no store credentials.

1. **Firefox add-on id.** `manifest.ts` uses the placeholder `open-in-gnosis@gnosis.app`. AMO ties the add-on to this id for good, so choose the final id before the first upload.
2. **Chrome Web Store.** Register a developer account (one-time fee) at the Chrome Web Store Developer Dashboard. Decide which Google account owns it; a group publisher account lets more than one person manage it. Upload `open-in-gnosis-chrome-<version>.zip`, fill in the listing and the privacy practices form (single purpose, permission reasons from the table above, "does not collect user data"), and submit for review.
3. **Microsoft Edge Add-ons.** Register in Partner Center (free) and upload the same `.zip`. Edge can also install from the Chrome Web Store, so this is optional.
4. **Firefox (AMO).** Firefox installs only signed add-ons, even unlisted ones. Create an AMO developer account. Choose **listed** (public page on addons.mozilla.org) or **unlisted** (signed file that you host, for example on the GitHub release). Then either upload the `.xpi` by hand, or create API credentials (AMO → Tools → Manage API Keys) and store them as CI secrets, for example `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, for a release job that runs:

   ```bash
   npx --yes web-ext@8 sign --source-dir dist-extension/firefox --channel listed \
     --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
   ```

   Run that only from a release workflow on tags, never on pull requests. The scripts are bundled from TypeScript (not minified), so AMO asks for the source with build steps: add `--upload-source-code <zip of the repo source>` and point the reviewer to "`npm ci`, then `npm run build:extension`".
5. **Versions.** Bump `EXTENSION_VERSION` in `manifest.ts` for each store upload. Stores reject a version they have seen.

### Store listing text

**Name:** Open in Gnosis

**Short description:** Open GitHub pull requests in the Gnosis code review app, at the same file, line or thread.

**Description:**

> Adds an "Open in Gnosis" button to GitHub pull request, commit and compare pages. One click opens the same pull request in the Gnosis desktop app, on the tab you were on, and at the file, line or review thread when there is one.
>
> You need the Gnosis app: https://github.com/oddur/gnosis/releases/latest
>
> The extension only reads the address of the GitHub page when you click the button or the toolbar icon. It makes no network requests and uses no GitHub token.

**Category:** Developer Tools

### Privacy statement

> Open in Gnosis does not collect, store or send any personal data or browsing data.
>
> When you click its button or toolbar icon on a GitHub page, the extension passes that page's address to the Gnosis app on your computer through a `gnosis://` link. The address does not leave your computer through the extension. The extension makes no network requests.
>
> The extension stores one setting in your browser: whether you dismissed the "Gnosis didn't open" hint. It does not use cookies, analytics or GitHub credentials.
>
> Permissions: access to github.com, to show the button; `storage`, for the setting above; `activeTab`, to read the address of the tab when you click the toolbar icon.
