import { BookMarked, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useMemo, type LazyExoticComponent } from 'react';
import { repositoryLucideName, type RepositorySettings } from '../lib/repository-settings';

// Load only icons that are shown, and retain the component across badge renders.
const loadedIcons = new Map<string, LazyExoticComponent<LucideIcon>>();
function lucideIcon(name: string) {
  let component = loadedIcons.get(name);
  if (!component) {
    // The name-to-loader map is large, so it loads with the first custom icon.
    component = lazy(async () => {
      const { default: icons } = await import('lucide-react/dynamicIconImports.mjs');
      return icons[name as keyof typeof icons]();
    });
    loadedIcons.set(name, component);
  }
  return component;
}
export function RepositoryIcon({ settings = {} }: { settings?: RepositorySettings }) {
  const name = repositoryLucideName(settings.icon ?? 'book');
  const Icon = useMemo(() => (name && name !== 'book-marked' ? lucideIcon(name) : BookMarked), [name]);
  return (
    <span className={`repository-icon repository-color-${settings.color ?? 'default'}`} aria-hidden="true">
      {settings.icon?.startsWith('emoji:') ? (
        <span className="repository-emoji">{settings.icon.slice(6)}</span>
      ) : (
        <Suspense fallback={<BookMarked size={15} />}>
          <Icon size={15} />
        </Suspense>
      )}
    </span>
  );
}
export function RepositoryMark({ repo, settings = {} }: { repo: string; settings?: RepositorySettings }) {
  return (
    <span className={`repository-mark repository-color-${settings.color ?? 'default'}`}>
      <RepositoryIcon settings={settings} />
      <span>{repo}</span>
    </span>
  );
}
