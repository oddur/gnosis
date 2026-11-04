import { BookMarked, GitCommitHorizontal, GitPullRequest, Layers } from 'lucide-react';

/** A stable identity cue. Status indicators remain separate. */
export function SubjectIcon({ kind }: { kind: 'stack' | 'pr' | 'repository' | 'commit' }) {
  const Icon = { stack: Layers, pr: GitPullRequest, repository: BookMarked, commit: GitCommitHorizontal }[kind];
  return <Icon className="subject-icon" aria-hidden="true" />;
}
