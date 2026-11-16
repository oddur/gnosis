// One manifest source; `build.ts` writes a Chrome/Edge and a Firefox variant from it.

export type TargetBrowser = 'chrome' | 'firefox';

/**
 * The extension version is the app version from package.json, so a release tag `vX.Y.Z` ships extension
 * X.Y.Z (the release workflow sets package.json from the tag). Stores accept only one to four dot-separated
 * integers, so a pre-release suffix (`0.41.0-beta.1`) is dropped from `version` and kept in `version_name`.
 */
export function extensionVersion(packageVersion: string): { version: string; versionName?: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(packageVersion);
  if (!match) throw new Error(`Unsupported package.json version for the extension: ${packageVersion}`);
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => part > 65535)) throw new Error(`Version part above 65535: ${packageVersion}`);
  const version = parts.join('.');
  return version === packageVersion ? { version } : { version, versionName: packageVersion };
}

/**
 * Placeholder Firefox add-on id. AMO ties signing and updates to this id, so choose the final one before
 * the first AMO upload; it cannot change afterwards.
 */
export const FIREFOX_ADDON_ID = 'open-in-gnosis@gnosis.app';

/** Pages the content script runs on. All of github.com, so it survives client-side navigation into a PR. */
export const CONTENT_SCRIPT_MATCHES = ['https://github.com/*'];

const ICONS = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '96': 'icons/icon-96.png',
  '128': 'icons/icon-128.png',
};

export function buildManifest(browser: TargetBrowser, packageVersion: string): Record<string, unknown> {
  const { version, versionName } = extensionVersion(packageVersion);
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'Open in Gnosis',
    version,
    ...(versionName && browser === 'chrome' ? { version_name: versionName } : {}),
    description: 'Adds an "Open in Gnosis" button to GitHub pull request, commit and compare pages.',
    homepage_url: 'https://github.com/oddur/gnosis',
    icons: ICONS,
    action: {
      default_title: 'Open in Gnosis',
      default_icon: { '16': ICONS['16'], '32': ICONS['32'] },
    },
    // storage: remembers that the "Gnosis didn't open" hint was dismissed. activeTab: the toolbar action
    // reads the clicked tab's URL. Neither shows an install warning.
    permissions: ['storage', 'activeTab'],
    content_scripts: [{ matches: CONTENT_SCRIPT_MATCHES, js: ['content.js'], run_at: 'document_idle' }],
  };

  if (browser === 'chrome') {
    manifest.minimum_chrome_version = '120';
    manifest.background = { service_worker: 'background.js' };
  } else {
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: '140.0',
        // AMO requires a declaration; the extension collects and transmits no data.
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  return manifest;
}
