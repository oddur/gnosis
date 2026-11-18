import {
  Activity, BookMarked, BookOpen, Bookmark, CircleAlert, CircleCheck, CircleHelp, CircleMinus,
  Clock3, Copy, FileDiff, FileText, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest,
  History, Inbox, Layers, LayoutList, Lightbulb, ListChecks, MessageSquare,
  MessageSquarePlus, MessagesSquare, Network, NotebookPen, RefreshCw, RotateCcw, Settings, Star, UserRound, VolumeX, AlarmClock,
  CircleX, Eye, GitCompareArrows, GitMerge, GitMergeConflict, LayoutDashboard, MessageSquareWarning, Sparkles,
  BellRing, GitPullRequestClosed, Hourglass,
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
  conflicts: { icon: GitMergeConflict, tone: 'danger' },
  replies: { icon: MessagesSquare, tone: 'warning' },
  restack: { icon: Layers, tone: 'warning' },
  'ready-to-merge': { icon: GitMerge, tone: 'success' },
  'explanation-ready': { icon: Sparkles, tone: 'info' },
};

/**
 * A PR that has merge conflicts with its base, everywhere the app says so: the attention catalog (menu bar, Overview),
 * Resolve conflicts… actions, the readiness line, stack branch status, and the queue's conflicts filter. Danger, as
 * the readiness line words it. A conflicted *file* inside the resolver is a different meaning and keeps its own icon.
 */
export const conflictIcon = GitMergeConflict;

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

/**
 * Row actions on the Overview. An action that changes something (on GitHub, or a snooze) carries its icon; an action
 * that only opens a PR (Review, Re-review, Reply, Open) carries none. Merge and re-run match PR actions and Checks;
 * Snooze matches the PR summary's snooze button and the sidebar's Snoozed.
 */
export const actionIcons = {
  merge: GitMerge,
  rerun: RefreshCw,
  nudge: BellRing,
  close: GitPullRequestClosed,
  snooze: AlarmClock,
};

/** How long a PR has waited in its current state. Not a clock: Clock3 means checks running. */
export const waitingIcon = Hourglass;
