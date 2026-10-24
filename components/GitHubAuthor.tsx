import { useEffect, useState } from 'react';
import { MapPin, Building2 } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from './ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { githubAvatarUrl, isGitHubLogin, type GitHubProfile } from '../lib/github-profile';

/** One author identity. Profile details load only after deliberate hover or keyboard focus. */
export function GitHubAuthor({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<GitHubProfile | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const valid = isGitHubLogin(login);
  useEffect(() => {
    if (!open || !valid) return;
    let cancelled = false;
    setProfile(null);
    setStatus('loading');
    void Promise.resolve()
      .then(() => window.electronAPI.getGitHubProfile(login))
      .then((value) => {
        if (!cancelled) {
          setProfile(value);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [login, open, valid]);
  if (!valid) return <span>{login}</span>;
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <a
            className="github-author"
            href={`https://github.com/${login.endsWith('[bot]') ? 'apps/' : ''}${encodeURIComponent(login.replace(/\[bot\]$/, ''))}`}
            aria-label={`${login} on GitHub`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void window.electronAPI.openExternal(event.currentTarget.href);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Avatar size="sm" className="github-author-avatar" aria-hidden="true">
              <AvatarImage src={githubAvatarUrl(login)} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="github-author-name">{login}</span>
          </a>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          collisionPadding={12}
          hideWhenDetached
          className="github-author-tooltip"
          onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
        >
          <strong>{profile?.name || login}</strong>
          {profile?.name && <span>@{profile.login}</span>}
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
          {status === 'loading' && <span role="status">Loading profile…</span>}
          {status === 'unavailable' && <span>Profile details unavailable. Open the author on GitHub.</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
