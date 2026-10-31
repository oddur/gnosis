// Run after upgrading lucide-react. The main process needs names, not React/SVG code.
import dynamicIconImports from 'lucide-react/dynamicIconImports.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../lib/lucide-icon-names.json', import.meta.url), JSON.stringify(Object.keys(dynamicIconImports).sort(), null, 2) + '\n');
