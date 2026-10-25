import { createRoot } from 'react-dom/client';
import { DiagramGallery } from './d2-gallery';
import { applyTheme } from '../../lib/theme';
import '../../src/globals.css';
import './d2-gallery.css';
applyTheme('system');
const root = document.getElementById('root');
if (root) createRoot(root).render(<DiagramGallery />);
