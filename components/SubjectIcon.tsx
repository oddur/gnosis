import { GitPullRequest, Layers } from 'lucide-react';

/** A stable identity cue. Status indicators remain separate. */
export function SubjectIcon({ kind }: { kind: 'stack' | 'pr' }) {
  const Icon = kind === 'stack' ? Layers : GitPullRequest;
  return <Icon className="subject-icon" aria-hidden="true" />;
}
