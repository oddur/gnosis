import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIEFING_MODEL_TIMEOUT_MS,
  PROVIDER_PAUSE_BACKOFF_MS,
  expiredProviderFailure,
  parseResetTime,
  providerPause,
  providerPauseNotice,
} from '../lib/provider-limits';
import { EFFORT_LEVELS } from '../lib/effort';

// Saturday 15 November 2026, 10:00 local time.
const now = new Date(2026, 10, 15, 10, 0).getTime();
const at = (month: number, day: number, hours: number, minutes = 0, year = 2026) => new Date(year, month, day, hours, minutes).getTime();

// Messages as the Gnosis app saved them from Codex and Claude Code.
const codexDated =
  'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 13th, 2026 1:25 PM.';
const codexToday = 'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:25 PM.';
const claudeRate = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const claudeGateway =
  'API Error: 503 auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5; last upstream error: rate_limit_error: This request would exceed your account\'s rate limit. Please try again later.)';
const claudeAuth = 'Failed to authenticate: OAuth session expired and could not be refreshed';

void test('reset times parse from the forms Codex and Claude Code print', () => {
  assert.equal(parseResetTime(codexDated, now), at(10, 13, 13, 25));
  assert.equal(parseResetTime(codexToday, now), at(10, 15, 13, 25));
  // A bare time already past today is tomorrow.
  assert.equal(parseResetTime('try again at 9:05 AM', now), at(10, 16, 9, 5));
  assert.equal(parseResetTime("You've hit your limit · resets 3pm (Europe/Berlin)", now), at(10, 15, 15));
  assert.equal(parseResetTime('Weekly limit reached · resets Nov 17, 9am', now), at(10, 17, 9));
  assert.equal(parseResetTime('spend limit reached · resets Jan 2', now), at(0, 2, 0, 0, 2027));
  assert.equal(parseResetTime('Rate limited. Try again in 20 minutes.', now), now + 20 * 60_000);
  assert.equal(parseResetTime('Claude AI usage limit reached|1763215200', now), 1763215200_000);
  assert.equal(parseResetTime(claudeRate, now), undefined);
});

void test('limits, rate limits and expired sign-ins pause a provider; other failures do not', () => {
  const usage = providerPause('codex', new Error(codexToday), now);
  assert.deepEqual([usage?.kind, usage?.until, usage?.resetKnown], ['usage', at(10, 15, 13, 25), true]);
  const rate = providerPause('claude', new Error(claudeRate), now);
  assert.deepEqual([rate?.kind, rate?.until, rate?.resetKnown], ['rate', now + PROVIDER_PAUSE_BACKOFF_MS.rate, false]);
  assert.equal(providerPause('claude', new Error(claudeGateway), now)?.kind, 'rate');
  const auth = providerPause('claude', new Error(claudeAuth), now);
  assert.deepEqual([auth?.kind, auth?.until], ['auth', now + PROVIDER_PAUSE_BACKOFF_MS.auth]);
  // A reset already past, such as an old message read again, falls back to the backoff.
  assert.equal(providerPause('codex', new Error(codexDated), now)?.until, now + PROVIDER_PAUSE_BACKOFF_MS.usage);
  for (const message of ['Briefing exceeded 90 seconds.', 'The model returned an invalid briefing.', 'GNOSIS_CANCELLED', 'This change updated during briefing.'])
    assert.equal(providerPause('codex', new Error(message), now), undefined, message);
});

void test('the notice names the provider and when automatic briefings resume', () => {
  const pause = providerPause('codex', new Error(codexToday), now);
  assert.ok(pause);
  const time = new Date(at(10, 15, 13, 25)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(
    providerPauseNotice(pause, now),
    `Codex usage limit reached. Automatic briefings resume at ${time}. You can still generate one manually.`
  );
  assert.match(providerPauseNotice({ ...pause, until: at(10, 16, 9) }, now), /resume at .+ tomorrow\./);
  const auth = providerPause('claude', new Error(claudeAuth), now);
  assert.ok(auth);
  assert.match(providerPauseNotice(auth, now), /^Claude needs you to sign in again\./);
});

void test('saved limit failures expire after their reset', () => {
  const failedAt = at(10, 12, 23, 5);
  assert.equal(expiredProviderFailure('codex', codexDated, failedAt, now), true);
  assert.equal(expiredProviderFailure('codex', codexToday, at(10, 15, 9, 0), now), false);
  assert.equal(expiredProviderFailure('codex', 'Briefing exceeded 90 seconds.', failedAt, now), false);
  assert.equal(expiredProviderFailure('codex', undefined, failedAt, now), false);
});

void test('model timeouts grow with effort and keep a ceiling', () => {
  const values = EFFORT_LEVELS.map((effort) => BRIEFING_MODEL_TIMEOUT_MS[effort]);
  assert.equal(values[0], 90_000);
  assert.deepEqual([...values].sort((a, b) => a - b), values);
  assert.ok(Math.max(...values) <= 300_000);
});
