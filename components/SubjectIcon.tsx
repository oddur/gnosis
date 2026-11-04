import { BookMarked, GitPullRequest, Layers } from 'lucide-react';

/** A stable identity cue. Status indicators remain separate. */
export function SubjectIcon({ kind }: { kind: 'stack' | 'pr' | 'repository' }) {
  const Icon = { stack: Layers, pr: GitPullRequest, repository: BookMarked }[kind];
  return <Icon className="subject-icon" aria-hidden="true" />;
}
