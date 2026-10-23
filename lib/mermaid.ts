// Mermaid owns global configuration; serialize theme setup with rendering so
// diagrams rendered together cannot inherit another diagram's theme.
let pending: Promise<void> = Promise.resolve();
let nextId = 0;

export function renderMermaid(chart: string, dark: boolean): Promise<string> {
  const rendered = pending.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      securityLevel: 'strict',
      suppressErrorRendering: true,
      themeVariables: {
        fontSize: '14px',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      },
    });
    const { svg } = await mermaid.render(`gnosis-mermaid-${++nextId}`, chart);
    return svg;
  });
  pending = rendered.then(
    () => undefined,
    () => undefined
  );
  return rendered;
}
