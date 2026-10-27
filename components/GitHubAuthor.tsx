import { useEffect, useState } from 'react';
import { MapPin, Building2 } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from './ui/avatar';
import { EntityBadge } from './EntityBadge';
import { githubAvatarUrl, isGitHubLogin, type GitHubProfile } from '../lib/github-profile';

/** One author identity. Profile details load only after deliberate hover or keyboard focus. */
export function GitHubAuthor({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<{ login: string; profile: GitHubProfile | null } | null>(null);
  const profile = resolved?.login === login ? resolved.profile : null;
  const valid = isGitHubLogin(login);
  useEffect(() => {
    if (!open || !valid) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.electronAPI.getGitHubProfile(login))
      .then((value) => {
        if (!cancelled) {
          setResolved({ login, profile: value });
        }
      })
      .catch(() => {
        if (!cancelled) setResolved({ login, profile: null });
      });
    return () => {
      cancelled = true;
    };
  }, [login, open, valid]);
  if (!valid) return <span>{login}</span>;
  return (
    <EntityBadge
      kind="user"
      value={login}
      className="github-author"
      href={`https://github.com/${login.endsWith('[bot]') ? 'apps/' : ''}${encodeURIComponent(login.replace(/\[bot\]$/, ''))}`}
      onTooltipOpenChange={(next) => {
        if (next) setResolved(null);
        setOpen(next);
      }}
      tooltipReady={resolved?.login === login}
      icon={
        <Avatar size="sm" className="github-author-avatar">
          <AvatarImage src={githubAvatarUrl(login)} alt="" loading="lazy" referrerPolicy="no-referrer" />
          <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      }
      tooltipContent={
        <>
          <strong>{profile?.name || login}</strong>
          <span>
            {login.endsWith('[bot]') || profile?.type === 'Bot' ? 'GitHub automation account' : 'GitHub author'}
          </span>
          {profile?.bio && <p>{profile.bio}</p>}
          {profile?.company && (
            <span className="github-author-detail">
              <Building2 size={13} />
              {profile.company}
            </span>
          )}
          {profile?.location && (
            <span className="github-author-detail">
              <MapPin size={13} />
              {profile.location}
            </span>
          )}
          {!profile && <span>Profile details unavailable. Right-click to open on GitHub.</span>}
        </>
      }
    />
  );
}
