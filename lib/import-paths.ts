/**
 * Local imports a source file makes, as repository-relative paths without an extension. The explanation's neighbour
 * reading (lib/github.ts getNeighborFiles) and chat's PR-wide context (lib/chat-pr-context.ts) both use it. No Node
 * imports.
 */
export function extractImports(content: string, filePath: string): string[] {
  const imports: string[] = [];
  const dir = filePath.split('/').slice(0, -1).join('/');

  // Match ES import statements
  const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith('.')) {
      // Relative import — resolve to a file path
      const resolved = resolveRelativePath(dir, importPath);
      if (resolved) imports.push(resolved);
    }
  }

  return imports;
}

function resolveRelativePath(dir: string, importPath: string): string | null {
  const parts = (dir ? dir + '/' + importPath : importPath).split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') normalized.pop();
    else if (part !== '.') normalized.push(part);
  }
  const base = normalized.join('/');
  // Return without extension — caller will try common extensions
  return base;
}

export const TS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

/** The changed file an import names: the base path itself, or with one of the extensions tried in order. */
export function resolveImport(base: string, files: ReadonlySet<string>): string | undefined {
  for (const extension of TS_EXTENSIONS) if (files.has(base + extension)) return base + extension;
  return undefined;
}
