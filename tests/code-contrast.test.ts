import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundledThemes } from 'shiki/themes';
import { CODE_THEMES } from '../lib/constants';
import { contrastRatio, diffSurfaces, readableCodeTheme } from '../lib/code-contrast';

for (const { id } of CODE_THEMES) {
  void test(`${id}: syntax remains readable on context and changed lines`, async () => {
    const original = (await bundledThemes[id]()).default;
    const theme = readableCodeTheme(original);
    const background = theme.colors?.['editor.background'] ?? theme.bg ?? '#1e1e1e';
    const colors = [theme.colors?.['editor.foreground'], theme.colors?.['gitDecoration.addedResourceForeground'], theme.colors?.['gitDecoration.deletedResourceForeground'], theme.fg,
      ...(theme.tokenColors ?? []).map((token) => token.settings.foreground)]
      .filter((color): color is string => !!color && /^#[\da-f]{6}$/i.test(color));
    assert.ok(colors.length > 5);
    assert.ok(theme.tokenColors?.every((token) => !token.settings.foreground || /^#[\da-f]{6}$/i.test(token.settings.foreground)), 'Translucent tokens must meet the same contrast floor');
    for (const color of colors) for (const surface of Object.values(diffSurfaces(background))) {
      assert.ok(contrastRatio(color, surface) >= 4.8, `${color} on ${surface}`);
    }
    assert.equal(theme.colors?.['editor.background'], original.colors?.['editor.background']);
  });
}
