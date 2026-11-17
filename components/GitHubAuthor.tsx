import { useEffect, useState } from 'react';
import { MapPin, Building2, Bell } from 'lucide-react';
import { ContextMenuItem } from './ui/context-menu';
import { toast } from './ui/toast';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { Avatar, AvatarImage, AvatarFallback } from './ui/avatar';
import { EntityBadge } from './EntityBadge';
import { githubAvatarUrl, isGitHubLogin, type GitHubProfile } from '../lib/github-profile';

/** One author identity. Profile details load only after deliberate hover or keyboard focus. */
export function GitHubAuthor({ login, bot = false, tabIndex }: { login: string; /** GraphQL reported a Bot. */ bot?: boolean; /** -1 keeps it out of the tab order. */ tabIndex?: number }) {
  const { allowBotNotifications, botNotificationsAllowed } = useRepositorySettings();
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
  const automation = bot || login.endsWith('[bot]') || profile?.type === 'Bot';
  // Bots never notify (#385) unless allowed here or in Settings › Notifications.
  const allowBot =
    automation && allowBotNotifications && botNotificationsAllowed && !botNotificationsAllowed(login) ? (
      <ContextMenuItem
        className="entry-menu-item"
        onClick={() =>
          void allowBotNotifications(login).then(
            () => toast.add({ type: 'success', title: `Notifications from ${login} are on` }),
            () => toast.add({ type: 'error', title: `Could not allow notifications from ${login}` })
          )
        }
      >
        <Bell size={15} />
        Allow notifications from this bot
      </ContextMenuItem>
    ) : undefined;
  return (
    <EntityBadge
      kind="user"
      value={login}
      tabIndex={tabIndex}
      className="github-author"
      href={`https://github.com/${login.endsWith('[bot]') ? 'apps/' : ''}${encodeURIComponent(login.replace(/\[bot\]$/, ''))}`}
      onTooltipOpenChange={(next) => {
        if (next) setResolved(null);
        setOpen(next);
      }}
      tooltipReady={resolved?.login === login}
      menuActions={allowBot}
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
