/**
 * Entry of the menu bar panel's renderer (#308), separate from the main window's bundle.
 */
import { createRoot } from 'react-dom/client';
import { MenubarView, useMenubarState } from '../../components/MenubarView';
import type { MenubarApi } from '../../lib/menubar-state';
import { followSystemAppearance } from './appearance';
import './menubar.css';

declare global {
  interface Window {
    gnosisMenubar: MenubarApi;
  }
}

followSystemAppearance();
// Main loads the page with ?vibrancy=1 when the window has the popover material behind it.
if (new URLSearchParams(location.search).has('vibrancy')) document.documentElement.dataset.vibrancy = '';

function Panel() {
  const state = useMenubarState(window.gnosisMenubar);
  return <MenubarView state={state} api={window.gnosisMenubar} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
