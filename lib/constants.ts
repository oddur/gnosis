import { createElement, type ComponentType, type SVGProps } from 'react';
import { Blocks, Sparkles, RefreshCw, Bug, TestTube2, Settings, FileText } from 'lucide-react';


export const CODE_THEMES = [
  { id: 'aurora-x', label: 'Aurora X' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'github-dark-dimmed', label: 'GitHub Dimmed' },
  { id: 'one-dark-pro', label: 'One Dark Pro' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'vitesse-dark', label: 'Vitesse Dark' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'poimandres', label: 'Poimandres' },
] as const;

export type CodeTheme = (typeof CODE_THEMES)[number]['id'];

export const CODE_FONTS = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: "'JetBrains Mono'" },
  { id: 'fira-code', label: 'Fira Code', family: "'Fira Code'" },
  { id: 'monaspace-neon', label: 'Monaspace Neon', family: "'Monaspace Neon'" },
  { id: 'iosevka', label: 'Iosevka', family: "'Iosevka'" },
  { id: 'hack', label: 'Hack', family: "'Hack'" },
] as const;

export type CodeFont = (typeof CODE_FONTS)[number]['id'];

// GitHub mark — Simple Icons (MIT), avoids deprecated lucide Github icon
export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return createElement(
    'svg',
    { viewBox: '0 0 24 24', fill: 'currentColor', ...props },
    createElement('path', {
      d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    })
  );
}

// Slide types are presented as quiet text in the chapter chip — the
// label and icon do the differentiation, not a colored fill. This
// matches the editorial brief: color is punctuation, not category
// shorthand. /distill may remove the icons entirely later.
export const slideTypeConfig: Record<
  string,
  { label: string; className: string; icon: ComponentType<{ className?: string }> }
> = {
  foundation: { label: 'Foundation', className: 'text-foreground/85', icon: Blocks },
  feature: { label: 'Feature', className: 'text-foreground/85', icon: Sparkles },
  refactor: { label: 'Refactor', className: 'text-foreground/85', icon: RefreshCw },
  bugfix: { label: 'Bug Fix', className: 'text-foreground/85', icon: Bug },
  test: { label: 'Test', className: 'text-foreground/85', icon: TestTube2 },
  config: { label: 'Config', className: 'text-foreground/85', icon: Settings },
  docs: { label: 'Docs', className: 'text-foreground/85', icon: FileText },
};

// Safe lookup for config objects keyed by AI-generated string values.
// The AI can return values outside the typed union (e.g. slideType
// "other", riskLevel "critical"), so every config lookup needs a
// fallback. This helper avoids repeating the cast-and-coalesce
// pattern at every call site.
export function safeConfigLookup<T>(config: Record<string, T>, key: string, fallback: T): T {
  return config[key] ?? fallback;
}

// Risk uses the warm editorial pill classes — same vocabulary as the
// status pills, just routed to the three semantic levels.
export const riskConfig: Record<string, { label: string; badgeClassName: string; variant: 'secondary' | 'default' | 'destructive' }> = {
  low: {
    label: 'Low Risk',
    badgeClassName: 'statusPill-neutral',
    variant: 'secondary' as const,
  },
  medium: {
    label: 'Medium Risk',
    badgeClassName: 'statusPill-amber',
    variant: 'default' as const,
  },
  high: {
    label: 'High Risk',
    badgeClassName: 'statusPill-red',
    variant: 'destructive' as const,
  },
};
