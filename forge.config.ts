import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'path';
import fs from 'fs';
import { publishAsPrerelease } from './lib/release-guard';

// The Release workflow writes the tag's version into package.json before it publishes (docs/releasing.md).
const version = (JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'gnosis',
    // Pinned to the value Forge used by default. macOS keys notification permission, Focus settings and saved
    // credentials by bundle id: changing it would reset them for every user.
    appBundleId: 'com.electron.gnosis',
    icon: path.resolve(__dirname, 'Icon/macos/AppIcon'),
    extraResource: [path.resolve(__dirname, 'Icon/tray'), path.resolve(__dirname, 'resources/mergiraf')],
    // macOS: CFBundleURLTypes for gnosis:// links (#309). Development builds use gnosis-dev:// and never register it here.
    protocols: [{ name: 'Gnosis', schemes: ['gnosis'] }],
    ...(process.env.APPLE_TEAM_ID
      ? {
          osxSign: {
            optionsForFile: () => ({
              entitlements: path.resolve(__dirname, 'entitlements.plist'),
              entitlementsInherit: path.resolve(__dirname, 'entitlements.child.plist'),
            }),
          },
          osxNotarize: {
            appleId: process.env.APPLE_ID ?? '',
            appleIdPassword: process.env.APPLE_ID_PASSWORD ?? '',
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      authors: 'Oddur Magnusson',
      iconUrl: 'https://raw.githubusercontent.com/oddur/gnosis/main/Icon/web/favicon.ico',
      setupIcon: path.resolve(__dirname, 'Icon/web/favicon.ico'),
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ name: 'Gnosis' }),
    new MakerDeb({}),
    new MakerRpm({ options: { license: 'MIT' } }),
  ],
  publishers: [
    new PublisherGithub({
      repository: { owner: 'oddur', name: 'gnosis' },
      draft: false,
      // vX.Y.Z-beta.N publishes as a GitHub prerelease, which update.electronjs.org and GitHub's "latest" skip (#404).
      // Throws when the workflow's GNOSIS_RELEASE_KIND disagrees with the version, so a beta never publishes as stable.
      prerelease: publishAsPrerelease(version, process.env.GNOSIS_RELEASE_KIND),
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/markdown-review-worker.ts', config: 'vite.markdown-worker.config.ts', target: 'main' },
        { entry: 'src/app-data-worker.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
        // The menu bar panel's own small preload (#308), none of the main window's API.
        { entry: 'src/menubar-preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
        // The menu bar panel (#308): menubar.html, src/menubar/main.tsx.
        { name: 'menubar_window', config: 'vite.menubar.config.ts' },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
