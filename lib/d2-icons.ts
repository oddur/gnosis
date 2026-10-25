/** Small, bundled role icons for the D2 prototype. No remote asset requests. */
const paths: Record<string, string> = {
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  server:
    '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>',
  queue: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  cloud: '<path d="M7 19a5 5 0 1 1 0-10 6 6 0 0 1 12-1 5.5 5.5 0 0 1 0 11Z"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/>',
};
export const D2_ICON_NAMES = Object.keys(paths);
export function d2IconData(name: string, dark: boolean): string {
  if (!paths[name]) throw new Error(`Unknown diagram icon: ${name}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="${dark ? '#b6ccff' : '#284eaf'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
export function resolveD2Icons(source: string, dark: boolean): string {
  return source.replace(
    /icon:\s*["']?gnosis:([a-z]+)["']?/g,
    (_, name: string) => `icon: "${d2IconData(name, dark)}"; icon.near: center-left; label.near: center-right`
  );
}
