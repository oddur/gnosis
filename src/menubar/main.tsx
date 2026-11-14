/**
 * Entry of the menu bar panel's renderer (#308), separate from the main window's bundle.
 * The panel is system chrome, so it follows the system appearance, not the app's theme setting.
 */
import { createRoot } from 'react-dom/client';
import { MenubarView, useMenubarState } from '../../components/MenubarView';
import type { MenubarApi } from '../../lib/menubar-state';
import './menubar.css';

declare global {
  interface Window {
    gnosisMenubar: MenubarApi;
  }
}

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyAppearance = () => document.documentElement.classList.toggle('dark', dark.matches);
applyAppearance();
dark.addEventListener('change', applyAppearance);
// Main loads the page with ?vibrancy=1 when the window has the popover material behind it.
if (new URLSearchParams(location.search).has('vibrancy')) document.documentElement.dataset.vibrancy = '';

function Panel() {
  const state = useMenubarState(window.gnosisMenubar);
  return <MenubarView state={state} api={window.gnosisMenubar} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
