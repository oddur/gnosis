/** Cached SVGs can appear in several previews and an expanded viewer at once. */
export function namespaceSVG(svg: string, instance: string): string {
  const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  if (!ids.size) return svg;
  const rename = (id: string) => (ids.has(id) ? `${id}-${instance}` : id);
  const escaped = [...ids].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${rename(id)}"`)
    .replace(/((?:xlink:)?href)="#([^"]+)"/g, (_, attr: string, id: string) => `${attr}="#${rename(id)}"`)
    .replace(/url\(#([^)]*)\)/g, (_, id: string) => `url(#${rename(id)})`)
    .replace(
      /<style\b([^>]*)>([\s\S]*?)<\/style>/g,
      (_, attrs: string, css: string) =>
        `<style${attrs}>${css.replace(new RegExp(`#(${escaped.join('|')})(?=[\\s.:{,>+~\\[]|$)`, 'g'), (_, id: string) => `#${rename(id)}`)}</style>`
    );
}
