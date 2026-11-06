import { BookOpen, FileDiff, GitCommitHorizontal, LayoutList, ListChecks, NotebookPen, MessagesSquare } from 'lucide-react';
import type { WorkspaceTab } from '../lib/navigation-history';

const sections = {
  summary: { label: 'Summary', icon: LayoutList },
  changes: { label: 'Changes', icon: FileDiff },
  commits: { label: 'Commits', icon: GitCommitHorizontal },
  checks: { label: 'Checks', icon: ListChecks },
  feedback: { label: 'Feedback', icon: MessagesSquare },
  explanation: { label: 'Explanation', icon: BookOpen },
  brief: { label: 'Local notes', icon: NotebookPen },
} satisfies Record<WorkspaceTab, { label: string; icon: typeof BookOpen }>;

export const workspaceTabs = (Object.keys(sections) as WorkspaceTab[]).map(tab => ({
  value: tab, label: sections[tab].label, workspaceTab: tab,
}));

/** Navigation identity, independent of the section's current status. */
export function WorkspaceIcon({ tab }: { tab: WorkspaceTab }) {
  const Icon = sections[tab].icon;
  return <Icon className="workspace-icon" aria-hidden="true" />;
}
