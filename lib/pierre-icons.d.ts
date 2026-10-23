declare module '@pierre/vscode-icons/scripts/themes/*.mjs' {
  type Colors = { dark: string; light: string };
  const icons: {
    name: string;
    svgName?: string;
    opacity?: number;
    color?: Colors | { fg: Colors; bg: Colors };
    fileExtensions?: string[];
    fileNames?: string[];
  }[];
  export default icons;
}

declare module '@pierre/vscode-icons/scripts/palette.mjs' {
  export const fill: { dark: string; light: string };
}
