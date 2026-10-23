import type { PrLabel } from './types';

type GitHubLabel = string | { name?: string; color?: string | null; description?: string | null };

export function parseGitHubLabels(labels: GitHubLabel[] = []): PrLabel[] {
  return labels.flatMap((label) => {
    const name = typeof label === 'string' ? label : label.name;
    if (!name) return [];
    return [{
      name,
      color: typeof label !== 'string' && label.color && /^[0-9a-f]{6}$/i.test(label.color) ? label.color : undefined,
      description: typeof label !== 'string' ? label.description ?? undefined : undefined,
    }];
  });
}
