// Run after upgrading lucide-react. The main process needs names, not React/SVG code.
import dynamicIconImports from 'lucide-react/dynamicIconImports.mjs';
import { writeFileSync } from 'node:fs';
import { bannedIconName } from '../lib/banned-icons.mjs';

// Banned icons (lib/banned-icons.mjs) are left out, so the repository icon picker never offers them.
const names = Object.keys(dynamicIconImports).filter((name) => !bannedIconName(name)).sort();
writeFileSync(new URL('../lib/lucide-icon-names.json', import.meta.url), JSON.stringify(names, null, 2) + '\n');
