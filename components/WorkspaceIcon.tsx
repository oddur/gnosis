import { workspaceSections as sections } from '../lib/interface-icons';
import type { WorkspaceTab } from '../lib/navigation-history';

export const workspaceTabs = (Object.keys(sections) as WorkspaceTab[]).map(tab => ({
  value: tab, label: sections[tab].label, workspaceTab: tab,
}));

/** Navigation identity, independent of the section's current status. */
export function WorkspaceIcon({ tab }: { tab: WorkspaceTab }) {
  const Icon = sections[tab].icon;
  return <Icon className="workspace-icon" aria-hidden="true" />;
}
