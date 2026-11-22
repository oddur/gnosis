import type { Provider } from './types';

/**
 * Provider failures that will repeat for every request until something outside Gnosis changes:
 * a usage limit, a rate limit, or an expired sign-in. Automatic work stops until `until`.
 */
export interface ProviderPause {
  provider: Provider;
  kind: 'usage' | 'rate' | 'auth';
  /** Epoch ms when automatic work may start again. */
  until: number;
  /** Whether `until` came from the provider's message, rather than a backoff. */
  resetKnown: boolean;
  /** The provider's own message, for details. */
  message: string;
  /** Epoch ms when the pause was recorded. */
  at: number;
}

/** Backoffs when the provider gives no reset time. */
export const PROVIDER_PAUSE_BACKOFF_MS = { usage: 60 * 60_000, rate: 15 * 60_000, auth: 30 * 60_000 } as const;
/** A parsed reset beyond this is treated as a misread, and the backoff is used instead. Weekly limits fit. */
const MAX_RESET_MS = 8 * 24 * 60 * 60_000;

const USAGE =
  /usage limit|hit your (?:usage )?limit|limit reached|out of credits|quota exceeded|insufficient_quota|credit balance (?:is )?too low|spend limit|usage not included|reached your (?:weekly |daily |monthly )?(?:usage )?limit/i;
const RATE = /rate[ _-]?limit|too many requests|\b429\b|overloaded|\b529\b/i;
const AUTH =
  /failed to authenticate|oauth session expired|please run \/login|not logged in|invalid api key|authentication_error|auth_unavailable|codex login|sign in again|\b401\b|unauthori[sz]ed/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "1:25 PM", "3pm", "13:05" → [hours, minutes], or undefined. */
function clock(text: string): [number, number] | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text.trim());
  if (!match || (!match[2] && !match[3])) return undefined;
  const [, hourText, minuteText, meridiemText] = match as (string | undefined)[];
  let hours = Number(hourText);
  const minutes = Number(minuteText ?? 0);
  const meridiem = meridiemText?.toLowerCase()[0];
  if (minutes > 59 || hours > 23 || (meridiem && (hours < 1 || hours > 12))) return undefined;
  if (meridiem === 'p' && hours < 12) hours += 12;
  if (meridiem === 'a' && hours === 12) hours = 0;
  return [hours, minutes];
}

/**
 * The reset time in a provider message, in local time. Handles the forms Codex and Claude Code print:
 * "try again at 1:25 PM", "try again at Nov 13th, 2026 1:25 PM", "resets 3pm (Europe/Berlin)",
 * "resets Nov 16, 9am", "try again in 2 hours", and Claude's "limit reached|1763212345".
 */
export function parseResetTime(message: string, now: number): number | undefined {
  const epoch = /\|(\d{10})(?:\D|$)/.exec(message);
  if (epoch) return Number(epoch[1]) * 1000;
  const relative = /\bin\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(
    message
  );
  if (relative) {
    const unit = relative[2].toLowerCase();
    const scale = unit.startsWith('s')
      ? 1000
      : unit.startsWith('m')
        ? 60_000
        : unit.startsWith('h')
          ? 3_600_000
          : 86_400_000;
    return now + Number(relative[1]) * scale;
  }
  const anchor = /\b(?:try again|resets?|reset|available again|resume)\s+(?:at|on|after)?\s*([^.;()\n]+)/i.exec(
    message
  );
  if (!anchor) return undefined;
  const text = anchor[1].trim();
  const base = new Date(now);
  const dated = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?,?\s*(?:at\s+)?(.*)$/.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    if (month < 0) return undefined;
    const [hours, minutes] = clock((dated[4] as string | undefined) ?? '') ?? [0, 0];
    const year = dated[3] ? Number(dated[3]) : base.getFullYear();
    let value = new Date(year, month, Number(dated[2]), hours, minutes).getTime();
    // "Jan 2" read in late December is next year.
    if (!dated[3] && value < now - 180 * 86_400_000)
      value = new Date(year + 1, month, Number(dated[2]), hours, minutes).getTime();
    return value;
  }
  const time = clock(text);
  if (!time) return undefined;
  const value = new Date(base.getFullYear(), base.getMonth(), base.getDate(), time[0], time[1]).getTime();
  // A bare time already past today means the same time tomorrow.
  return value <= now ? value + 86_400_000 : value;
}

/** Classify a provider failure that will repeat until a reset or a new sign-in. */
export function providerPause(provider: Provider, error: unknown, now: number): ProviderPause | undefined {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  const kind = USAGE.test(message) ? 'usage' : RATE.test(message) ? 'rate' : AUTH.test(message) ? 'auth' : undefined;
  if (!kind) return undefined;
  const reset = kind === 'auth' ? undefined : parseResetTime(message, now);
  const resetKnown = reset !== undefined && reset > now && reset - now <= MAX_RESET_MS;
  return {
    provider,
    kind,
    until: resetKnown ? reset : now + PROVIDER_PAUSE_BACKOFF_MS[kind],
    resetKnown,
    message: message.slice(0, 600),
    at: now,
  };
}

/** Whether a stored failure message is a provider pause whose reset has already passed. */
export function expiredProviderFailure(provider: Provider, message: string | undefined, failedAt: number, now: number) {
  if (!message) return false;
  const pause = providerPause(provider, new Error(message), failedAt);
  return !!pause && pause.until <= now;
}

const LABELS: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
/** The provider's name, such as "Claude". */
export const providerName = (provider: Provider) => LABELS[provider];

function when(until: number, now: number) {
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** One line for the activity panel and the queue: what happened, and when automatic briefings resume. */
export function providerPauseNotice(pause: ProviderPause, now: number): string {
  const name = LABELS[pause.provider];
  const reason =
    pause.kind === 'usage'
      ? `${name} usage limit reached.`
      : pause.kind === 'rate'
        ? `${name} is rate limiting requests.`
        : `${name} needs you to sign in again.`;
  return `${reason} Automatic briefings resume at ${when(pause.until, now)}. You can still generate one manually.`;
}

/** One line for conflict proposals (#445 item 7): the model is skipped until the pause ends, such as "Claude is paused until 14:00." */
export function conflictPauseNotice(pause: Pick<ProviderPause, 'provider' | 'until'>, now: number): string {
  return `${LABELS[pause.provider]} is paused until ${when(pause.until, now)}.`;
}

/**
 * How long a briefing's model call may run. Logged briefings finish in 5 to 9 seconds at Low effort, so 90 seconds
 * stays the floor. Higher effort reasons longer. The ceiling keeps a hung CLI from holding the briefing queue.
 */
export const BRIEFING_MODEL_TIMEOUT_MS: Record<import('./effort').Effort, number> = {
  low: 90_000,
  medium: 120_000,
  high: 180_000,
  xhigh: 240_000,
  max: 300_000,
  ultra: 300_000,
};
/** GitHub reads for a briefing wait behind interactive work. A slow read defers the briefing; it is not a failure. */
export const BRIEFING_EVIDENCE_TIMEOUT_MS = 120_000;
/** When a deferred briefing tries again, and how many deferrals before it fails. */
export const BRIEFING_DEFER_MS = 5 * 60_000;
export const BRIEFING_MAX_DEFERRALS = 3;
/** Automatic briefing failures leave Activity after this. They stay on the PR, with Retry. */
export const FAILED_BRIEFING_RETENTION_MS = 24 * 60 * 60_000;
