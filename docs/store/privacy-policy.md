# Open in Gnosis browser extension: privacy policy

Last updated: 16 November 2026

This policy covers the **Open in Gnosis** browser extension for Chrome, Edge and Firefox. It does not cover the Gnosis desktop app or GitHub.

## Summary

Open in Gnosis does not collect, store or send any personal data or browsing data. It makes no network requests.

## What the extension does

- **On github.com,** a content script reads the address of the current page. It uses the address only to decide whether the page is a pull request, commit or compare page, and to show or hide the "Open in Gnosis" button. It does not read the page's text, code, comments or forms.
- **When you click** the button or the toolbar icon, the extension opens a `gnosis://open?url=...` link. The link holds the address of the current GitHub page. Your browser gives this link to the Gnosis app on your computer. The address does not leave your computer through the extension.
- **If Gnosis does not open,** the extension shows a hint with a link to the Gnosis download page on GitHub. The browser opens that page only if you click the link.

## What the extension stores

One setting in your browser's extension storage: `gnosisHintDismissed: true`, after you close the "Gnosis didn't open" hint. It stays on your computer and is removed when you remove the extension.

## What the extension does not do

- It does not send data to the developer or to any other party. It has no server.
- It does not use analytics, tracking, advertising or cookies.
- It does not read or use your GitHub sign-in, tokens or cookies.
- It does not keep a history of the pages you visit.
- It does not run on any site other than github.com.
- It does not load or run code from the network.

## Permissions

- **Access to github.com:** to show the button on pull request, commit and compare pages.
- **storage:** for the one setting above.
- **activeTab:** to read the address of the tab when you click the toolbar icon.

## The Gnosis app

When the extension opens a link, the Gnosis desktop app handles it. The app is a separate program with its own behaviour. It connects to GitHub with your own account to show the pull request. See https://github.com/oddur/gnosis.

## Changes and contact

If this policy changes, the new version will be in this file, with a new date. The history is in the repository.

Questions: open an issue at https://github.com/oddur/gnosis/issues.
