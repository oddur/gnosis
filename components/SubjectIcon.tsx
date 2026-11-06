import { subjectIcons } from '../lib/interface-icons';

/** A stable identity cue. Status indicators remain separate. */
export function SubjectIcon({ kind }: { kind: 'stack' | 'pr' | 'repository' | 'commit' }) {
  const Icon = subjectIcons[kind];
  return <Icon className="subject-icon" aria-hidden="true" />;
}
