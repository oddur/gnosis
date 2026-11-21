# Submitting Open in Gnosis to the browser stores

This is the checklist for publishing the extension. The text to paste is in [listing.md](listing.md), the images are in [images/](images/), and the privacy policy is [privacy-policy.md](privacy-policy.md).

The first version must be uploaded by hand in each store, because the store APIs can only update an existing item. After that, `.github/workflows/extension-publish.yml` uploads new versions on release tags, once the secrets below are set.

## 0. Before the first upload

1. **Choose the Firefox add-on id.** `FIREFOX_ADDON_ID` in `extensions/browser/manifest.ts` is a placeholder (`open-in-gnosis@gnosis.app`). AMO ties the add-on to this id permanently. Use an address form on a domain you control, for example `open-in-gnosis@gnosis.to`. Change it, merge, and then release.
2. **Get the packages.** Push a release tag as usual (`vX.Y.Z`). The **Publish browser extension** workflow runs. Its store jobs skip because no secrets are set. Download the artifact `open-in-gnosis-X.Y.Z` from the run. It has:
   - `open-in-gnosis-chrome-X.Y.Z.zip`: for Chrome and Edge
   - `open-in-gnosis-firefox-X.Y.Z.zip`: for Firefox
   - `open-in-gnosis-source-X.Y.Z.zip`: the source for AMO review

   To build them locally instead: check out the tag, run `npm ci`, `npm version X.Y.Z --no-git-tag-version`, then `npm run build:extension`. The files are in `dist-extension/`. Do not commit the `package.json` change.

The extension version is the app version. Stores reject a version they already have, so each upload must come from a newer release.

## 1. Chrome Web Store

**Account** (one-time US$5 registration fee):

1. Go to https://chrome.google.com/webstore/devconsole and sign in with the Google account that will own the extension. To let more than one person manage it, create a group publisher later in **Account**.
2. Accept the developer agreement and pay the fee.
3. In **Account**, verify the contact email. Declare trader or non-trader status (non-trader, if you do not sell anything). Google requires 2-Step Verification on the account.

**First submission:**

1. Click **New item** and upload `open-in-gnosis-chrome-X.Y.Z.zip`.
2. **Store listing** tab:
   - Description: "Long description" from listing.md. The summary comes from the package.
   - Category: Developer Tools. Language: English.
   - Store icon: `images/icon-128-store.png`.
   - Screenshots: the four `images/screenshot-*.png` files.
   - Small promo tile: `images/promo-small-440x280.png`.
   - Homepage URL and support URL: from the table in listing.md.
3. **Privacy** tab:
   - Single purpose: from listing.md.
   - Permission justifications: `storage`, `activeTab` and host permission, from the table in listing.md.
   - Remote code: "No, I am not using remote code".
   - Data usage: check no data types, and check the three certifications.
   - Privacy policy URL: `https://github.com/oddur/gnosis/blob/main/docs/store/privacy-policy.md`
4. **Distribution** tab: Public, all regions.
5. **Test instructions** tab: paste "Test instructions for reviewers" from listing.md.
6. Click **Submit for review**.

**API credentials for CI:**

1. In https://console.cloud.google.com, create a project (for example "gnosis-store"). Enable the **Chrome Web Store API**.
2. **OAuth consent screen:** user type External, app name "Gnosis publishing", your email. Then set the publishing status to **In production**. In "Testing" status, the refresh token expires after 7 days.
3. **Credentials → Create credentials → OAuth client ID:** type **Web application**. Add the authorized redirect URI `https://developers.google.com/oauthplayground`. Copy the client ID and client secret.
4. Open https://developers.google.com/oauthplayground. Click the gear icon, check **Use your own OAuth credentials**, and paste the client ID and secret. In step 1, enter the scope `https://www.googleapis.com/auth/chromewebstore` and click **Authorize APIs**. Sign in with the account that owns the extension, and accept the "unverified app" warning (it is your own app). In step 2, click **Exchange authorization code for tokens** and copy the **refresh token**.
5. The extension id is the 32-letter id on the item's **Package** tab. The publisher id is in the developer dashboard under the publisher's **Settings**.

| GitHub secret | Value |
|---|---|
| `CHROME_EXTENSION_ID` | the item's 32-letter id |
| `CHROME_PUBLISHER_ID` | the publisher id (the v2 API needs it in the URL) |
| `CHROME_CLIENT_ID` | OAuth client ID |
| `CHROME_CLIENT_SECRET` | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | refresh token from the OAuth Playground |

## 2. Microsoft Edge Add-ons (free, optional)

Edge can also install the extension from the Chrome Web Store. A listing in Edge Add-ons is easier to find for Edge users.

**Account:** go to https://partner.microsoft.com/dashboard/microsoftedge/public/login and register for the Microsoft Edge program with a Microsoft account. There is no fee.

**First submission:**

1. **Microsoft Edge → Overview → Create new extension.** Upload `open-in-gnosis-chrome-X.Y.Z.zip` (the same file as Chrome).
2. **Availability:** Public, all markets.
3. **Properties:** category Developer tools. "Does your extension access, collect or transmit personal information?": No. Privacy policy URL, website URL and support contact from listing.md.
4. **Store listings → English:** description: "Long description" from listing.md. Extension logo: `images/icon-300-edge.png`. Small promotional tile: `images/promo-small-440x280.png`. Screenshots: `images/screenshot-*.png`. Search terms from listing.md.
5. **Submit**, and paste "Test instructions for reviewers" from listing.md into **Notes for certification**.

**API credentials for CI:**

1. In Partner Center, open **Microsoft Edge → Publish API**. Click **Enable** next to the new experience (API keys), then **Create API credentials**.
2. Copy the **Client ID** and the **API key**. The page shows when the key expires. Renew it before then and update the secret.
3. The product id is on the extension's overview page, under **Extension identity**.

| GitHub secret | Value |
|---|---|
| `EDGE_PRODUCT_ID` | Product ID (a GUID) |
| `EDGE_CLIENT_ID` | Client ID |
| `EDGE_API_KEY` | API key |

## 3. Firefox Add-ons (AMO, free)

**Account:** sign in at https://addons.mozilla.org/developers/ with a Mozilla account. Accept the developer agreement. There is no fee.

**First submission:**

1. **Submit a New Add-on → On this site** (a listed add-on).
2. Upload `open-in-gnosis-firefox-X.Y.Z.zip`. Leave Firefox for Android unchecked: the extension is for desktop.
3. "Do you need to submit source code?": **Yes**. Upload `open-in-gnosis-source-X.Y.Z.zip`.
4. Listing details: name; Summary: the short description from listing.md; Description: "Long description" from listing.md; category Web Development; support site `https://github.com/oddur/gnosis/issues`; license MIT; privacy policy (optional): the URL from listing.md.
5. **Notes to reviewer:** paste "Test instructions for reviewers" from listing.md.
6. Submit. After the add-on is created, upload the 1280x800 screenshots on its **Edit Product Page** (Images).

**API credentials for CI:** open https://addons.mozilla.org/developers/addon/api/key/ and click **Generate new credentials**.

| GitHub secret | Value |
|---|---|
| `AMO_JWT_ISSUER` | JWT issuer (looks like `user:12345:678`) |
| `AMO_JWT_SECRET` | JWT secret |

## 4. Add the secrets

In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Or, from the command line:

```bash
gh secret set CHROME_EXTENSION_ID --repo oddur/gnosis
```

`gh` asks for the value. Set only the secrets for the stores you use. A store without secrets is skipped.

## 5. After that

- On each release tag, the workflow uploads to the stores when `extensions/browser` changed since the previous release. Each store reviews the new version before it goes live.
- To publish an unchanged extension, or to retry, run **Actions → Publish browser extension → Run workflow** with the tag. You can choose one store.
- Pre-release tags (`v1.2.3-beta.1`) only build.
- Listing text and images are not updated by the API. Change them in each store's dashboard.
- To refresh the images after a UI change: `npm run build:extension && npm run extension:store-assets`.
