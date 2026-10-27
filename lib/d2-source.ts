import { resolveD2Icons } from './d2-icons';

/** Shared by the browser renderer and compiler-backed prompt checks. */
export function prepareD2Source(source: string, dark: boolean): string {
  if (source.length > 40000) throw new Error('This diagram is too large. Split it into smaller concepts.');
  if (
    /(?:https?:\/\/|file:\/\/|data:(?:image|text|application)\/|javascript:|@import|(?:^|[\s.=:])@[^\s])/im.test(source)
  ) {
    throw new Error('Use self-contained D2 and bundled gnosis: icons; external resources are disabled.');
  }
  const palette = dark
    ? {
        N1: '#e3e7ef',
        N2: '#a2adbf',
        N3: '#77849a',
        N4: '#424b5c',
        N5: '#343b48',
        N6: '#242a34',
        N7: '#1d2129',
        B1: '#c5d7ff',
        B2: '#a6bfff',
        B3: '#7396d9',
        B4: '#424f6a',
        B5: '#273957',
        B6: '#242f43',
        AA2: '#e0bfff',
        AA4: '#66517b',
        AA5: '#3e304b',
        AB4: '#50726b',
        AB5: '#263f3a',
      }
    : {
        N1: '#242a35',
        N2: '#626b7b',
        N3: '#7b8698',
        N4: '#b8c2d2',
        N5: '#d5dbe5',
        N6: '#f0f2f6',
        N7: '#ffffff',
        B1: '#24469c',
        B2: '#284eaf',
        B3: '#6c8bce',
        B4: '#a6bfff',
        B5: '#d8e3fc',
        B6: '#eaf0ff',
        AA2: '#62448a',
        AA4: '#bda6da',
        AA5: '#ede4f7',
        AB4: '#86b5a7',
        AB5: '#e0f0e9',
      };
  const theme = Object.entries(palette)
    .map(([name, value]) => `${name}: "${value}"`)
    .join('; ');
  return (
    resolveD2Icons(source, dark) +
    // Triple globs cross board boundaries. Double globs leave native steps at
    // D2's smaller default font, changing both text metrics and layout.
    `\n***.style.font-size: 24\n(*** -> ***)[*].style.font-size: 20\nvars: { d2-config: { theme-overrides: { ${theme} }; layout-engine: tala } }\n`
  );
}
