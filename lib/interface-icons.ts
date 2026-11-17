import {
  Activity, BookMarked, BookOpen, Bookmark, CircleAlert, CircleCheck, CircleHelp, CircleMinus,
  Clock3, Copy, FileDiff, FileText, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest,
  History, Inbox, Layers, LayoutList, Lightbulb, ListChecks, MessageSquare,
  MessageSquarePlus, MessagesSquare, Network, NotebookPen, RefreshCw, RotateCcw, Settings, Star, UserRound, VolumeX, AlarmClock,
  CircleX, Eye, GitCompareArrows, GitMerge, LayoutDashboard, MessageSquareWarning, Sparkles, TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceTab } from './navigation-history';
import type { AttentionKind } from './attention';

/** Entity identity stays separate from PR state and check results. */
export const subjectIcons = {
  stack: Layers, pr: GitPullRequest, repository: BookMarked,
  commit: GitCommitHorizontal, branch: GitBranch, user: UserRound,
};

export const workspaceSections = {
  summary: { label: 'Summary', icon: LayoutList },
  changes: { label: 'Changes', icon: FileDiff },
  commits: { label: 'Commits', icon: subjectIcons.commit },
  checks: { label: 'Checks', icon: ListChecks },
  feedback: { label: 'Feedback', icon: MessagesSquare },
  explanation: { label: 'Explanation', icon: BookOpen },
  brief: { label: 'Local notes', icon: NotebookPen },
} satisfies Record<WorkspaceTab, { label: string; icon: LucideIcon }>;

/** Shared choices for features appearing in menus, search and toolbars. */
export const workbenchIcons = {
  briefing: FileText,
  chat: MessageSquare,
  review: MessageSquarePlus,
  savedView: Bookmark,
  settings: Settings,
  history: History,
  insight: Lightbulb,
  diagram: Network,
  copy: Copy,
  queue: Inbox,
  starred: Star,
  muted: VolumeX,
  snoozed: AlarmClock,
  refresh: RefreshCw,
  overview: LayoutDashboard,
  activity: Activity,
  localChanges: FolderGit2,
  setup: RotateCcw,
  help: CircleHelp,
};

/**
 * Each attention kind's icon and tone, shared by the menu bar panel and the Overview. Tones name status colours:
 * review is the action blue, the others the semantic colours. Words always accompany them.
 */
export const attentionIcons: Record<AttentionKind, { icon: LucideIcon; tone: 'review' | 'danger' | 'warning' | 'success' | 'info' }> = {
  'review-requested': { icon: Eye, tone: 'review' },
  'updated-since-review': { icon: GitCompareArrows, tone: 'review' },
  'changes-requested': { icon: MessageSquareWarning, tone: 'danger' },
  'checks-failed': { icon: CircleX, tone: 'danger' },
  conflicts: { icon: TriangleAlert, tone: 'warning' },
  replies: { icon: MessagesSquare, tone: 'warning' },
  restack: { icon: Layers, tone: 'warning' },
  'ready-to-merge': { icon: GitMerge, tone: 'success' },
  'explanation-ready': { icon: Sparkles, tone: 'info' },
};

export const checkGroupIcons = {
  attention: CircleAlert, running: Clock3, passed: CircleCheck, skipped: CircleMinus,
};

export const checkSummaryIcons = {
  failure: checkGroupIcons.attention,
  pending: checkGroupIcons.running,
  success: checkGroupIcons.passed,
  neutral: checkGroupIcons.skipped,
  unknown: CircleHelp,
};
