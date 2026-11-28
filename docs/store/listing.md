# Open in Gnosis: store listing

Copy these fields into the store forms. [SUBMITTING.md](SUBMITTING.md) says which field goes where. Images are in [images/](images/).

## Name

Open in Gnosis

## Short description

Chrome uses the manifest `description` as the summary (132 characters at most). AMO calls this the **Summary** (250 at most).

> Adds an "Open in Gnosis" button to GitHub pull request, commit and compare pages.

## Long description

> Open in Gnosis adds a button to GitHub pull request, commit and compare pages. Click it to open the same page in the Gnosis desktop app for code review. Gnosis opens the tab you were on, and the file, line or review thread when the address has one.
>
> The toolbar icon does the same thing. It is active only on pages that Gnosis can open.
>
> You need the Gnosis app for macOS, Windows or Linux. Get it from https://github.com/oddur/gnosis/releases/latest. If you click the button and Gnosis does not open, the extension shows a short hint with that link. You can close the hint for good.
>
> Privacy: the extension does not collect or send any data. It makes no network requests and does not use your GitHub account. When you click, it gives the address of the current page to the Gnosis app on your computer through a gnosis:// link. It stores one setting: whether you closed the hint.
>
> Gnosis is open source: https://github.com/oddur/gnosis. Gnosis is not affiliated with GitHub.

## Single purpose (Chrome)

> Open the current GitHub pull request, commit or compare page in the Gnosis desktop app with one click.

## Permission justifications

| Permission | Justification to paste |
|---|---|
| Host access: content script on `https://github.com/*` | The content script adds the "Open in Gnosis" button to GitHub pull request, commit and compare pages. It must match all of github.com because GitHub moves between pages without a full page load (for example, from the pull request list into a pull request). A script that matched only pull request URLs would not run after such a move. On other GitHub pages the script does nothing. It reads only the page address, and only to decide whether to show the button and to build the link when the user clicks. |
| `storage` | Stores one value, `gnosisHintDismissed: true`, after the user closes the "Gnosis didn't open" hint, so the hint does not come back. No page data is stored. |
| `activeTab` | When the user clicks the toolbar icon, the background script reads the address of that tab and opens it in the Gnosis app. `activeTab` gives this access only for the tab the user clicked, and only at that moment. It replaces the broader `tabs` permission. |

Not requested: `tabs`, `scripting`, `host_permissions`, `cookies`, `webRequest`, or any other permission. Neither `storage` nor `activeTab` shows an install warning. The content script match shows "Read and change your data on github.com".

**Remote code (Chrome):** No, I am not using remote code. All JavaScript is in the package. There is no `eval`, no `new Function`, and no script loaded from a server.

## Data usage (Chrome privacy practices form)

**What user data do you plan to collect from users now or in the future?** Check none of the boxes:

- Personally identifiable information: no
- Health information: no
- Financial and payment information: no
- Authentication information: no
- Personal communications: no
- Location: no
- Web history: no
- User activity: no
- Website content: no

Why "web history" and "website content" are no: the extension reads the address of the GitHub page only when the user clicks. It passes the address to the Gnosis app on the same computer. It never sends the address, or anything else, to the developer or to any server.

**Certify all three:**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/oddur/gnosis/blob/main/docs/store/privacy-policy.md

## Firefox data collection

The Firefox manifest declares `data_collection_permissions: { required: ["none"] }`. On AMO, answer that the add-on does not collect or transmit data. A privacy policy is optional on AMO for an add-on that collects nothing. You can add the same URL.

## Category, links and other fields

| Field | Value |
|---|---|
| Chrome Web Store category | Developer Tools |
| Edge Add-ons category | Developer tools |
| AMO category (Firefox) | Web Development |
| Language | English |
| Homepage / website | https://gnosis.to |
| Support URL | https://github.com/oddur/gnosis/issues |
| Privacy policy URL | https://github.com/oddur/gnosis/blob/main/docs/store/privacy-policy.md |
| License (AMO) | MIT |
| Search terms (Edge, up to 7) | GitHub, pull request, code review, Gnosis, diff, review, developer tools |
| Mature content | No |
| Paid features or in-app purchases | No |

## Test instructions for reviewers

Paste in Chrome's **Test instructions**, Edge's **Notes for certification**, and AMO's **Notes to reviewer**:

> 1. Open any public GitHub pull request, for example https://github.com/oddur/gnosis/pull/380. No GitHub sign-in is needed.
> 2. An "Open in Gnosis" button shows next to the pull request title. The toolbar icon is active on this page.
> 3. Click the button. With the Gnosis desktop app installed (https://github.com/oddur/gnosis/releases/latest), the browser asks to open Gnosis and Gnosis shows the same pull request. Without the app, nothing opens, and after 1.5 seconds a hint says "Gnosis didn't open. Get Gnosis".
> 4. Open a page that is not a pull request, commit or compare page (for example https://github.com/oddur/gnosis). The button goes away and the toolbar icon is greyed out.
>
> The extension makes no network requests. For AMO: the scripts are bundled from TypeScript with esbuild and are not minified. The source archive has the build steps in SOURCE-BUILD.md.

## Images

All images are made from a synthetic page with made-up names (`example-org/sample-app`), by `npm run build:extension && npm run extension:store-assets`. No real user data or GitHub assets are in them.

| File | Size | Use |
|---|---|---|
| `images/icon-128-store.png` | 128x128 (96x96 artwork, transparent padding) | Chrome store icon |
| `images/icon-300-edge.png` | 300x300 | Edge extension logo |
| `images/icon-96.png`, `images/icon-48.png` | 96x96, 48x48 | AMO icon if asked (AMO normally takes the icon from the package) |
| `images/promo-small-440x280.png` | 440x280 | Chrome small promo tile, Edge small promotional tile |
| `images/screenshot-1-pull-request-light.png` | 1280x800 | Screenshot: button on a pull request (light) |
| `images/screenshot-2-files-dark.png` | 1280x800 | Screenshot: Files changed tab (dark) |
| `images/screenshot-3-compare.png` | 1280x800 | Screenshot: floating button on a compare page |
| `images/screenshot-4-not-installed.png` | 1280x800 | Screenshot: the "Gnosis didn't open" hint |

The package itself has 16, 32, 48, 96 and 128 px icons (`extensions/browser/icons/`).
