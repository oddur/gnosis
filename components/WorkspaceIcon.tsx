import { workspaceSections as sections } from '../lib/interface-icons';
import type { WorkspaceTab } from '../lib/navigation-history';

// Feedback is no longer a tab of its own: it opens Conversation (`conversationTab`). Conflicts is a tab only while its
// view is open (PrSummary adds it).
export const workspaceTabs = (Object.keys(sections) as WorkspaceTab[]).filter(tab => tab !== 'feedback' && tab !== 'conflicts').map(tab => ({
  value: tab, label: sections[tab].label, workspaceTab: tab,
}));

export const conflictsTab = { value: 'conflicts' as WorkspaceTab, label: sections.conflicts.label, workspaceTab: 'conflicts' as WorkspaceTab };

/** Navigation identity, independent of the section's current status. */
export function WorkspaceIcon({ tab }: { tab: WorkspaceTab }) {
  const Icon = sections[tab].icon;
  return <Icon className="workspace-icon" aria-hidden="true" />;
}
