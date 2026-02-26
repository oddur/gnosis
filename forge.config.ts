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

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'gnosis',
    icon: path.resolve(__dirname, 'Icon/macos/AppIcon'),
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
      prerelease: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
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
