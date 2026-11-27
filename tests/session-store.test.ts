import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerSessionRequests, markSessionFinished, peekSessionState, publishSession, requestSession, takeSessionRequest } from '../lib/session-store';

/** The guided session as a PR page sees it (lib/session-store.ts): its bar, Back and Next, and finished PRs. */

const step = (n: number) => ({ id: `s${n}`, url: `https://github.com/o/r/pull/${n}`, number: n, title: `PR ${n}`, why: '' });

void test('a PR of the run is marked finished once; others are not the session’s', () => {
  publishSession({ steps: [step(1), step(2)], index: 0 });
  markSessionFinished(step(2).url);
  markSessionFinished('https://github.com/o/r/pull/99');
  assert.deepEqual([...(peekSessionState()?.finished ?? [])], [step(2).url]);
  // Publishing the same run again keeps what was finished; a PR that left the run drops out.
  publishSession({ steps: [step(1), step(2)], index: 1 });
  assert.equal(peekSessionState()?.finished.has(step(2).url), true);
  publishSession({ steps: [step(1)], index: 0 });
  assert.equal(peekSessionState()?.finished.size, 0);
  publishSession(null);
  assert.equal(peekSessionState(), null);
});

void test('Back and Next reach the mounted Overview, or wait for it to mount', () => {
  const heard: string[] = [];
  const stop = answerSessionRequests((request, url) => heard.push(`${request} ${url}`));
  requestSession('next', step(1).url);
  assert.deepEqual(heard, [`next ${step(1).url}`]);
  assert.equal(takeSessionRequest(), undefined, 'Answered: nothing waits');
  stop();
  requestSession('back', step(2).url);
  assert.deepEqual(takeSessionRequest(), { request: 'back', url: step(2).url }, 'No Overview mounted: it waits');
  assert.equal(takeSessionRequest(), undefined, 'Taken once');
});
