/**
 * The panel is system chrome: it follows the system appearance, not the app's theme setting, because the vibrancy
 * material behind it does (#308 section 4.3). Shared by the panel entry and its browser fixture.
 */
export function followSystemAppearance(root: HTMLElement = document.documentElement, media = window.matchMedia('(prefers-color-scheme: dark)')) {
  const apply = () => root.classList.toggle('dark', media.matches);
  apply();
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
