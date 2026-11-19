import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffUntil,
  createSyntaxContentsScheduler,
  permanentFailure,
  syntaxContentsDiagnostics,
  syntaxContentsPlan,
  syntaxReadMode,
  SYNTAX_CONTENTS_MAX_CHARACTERS,
  type SyntaxContentsFailure,
  type SyntaxContentsJob,
  type SyntaxContentsTier,
} from '../lib/syntax-contents';
import { inspectionRank, type InspectionMode, type PrChangeFile, type PrFileSide } from '../lib/pr-changes';
import { createPrFileCache } from '../lib/pr-file-cache';
import {
  DEFAULT_CODE_INTELLIGENCE,
  codeIntelligenceSettings,
  languageEnabled,
  pathEnabled,
  withLanguage,
} from '../lib/code-intelligence';

/**
 * The queue that loads file contents for hunk scopes (#393): view reads first, prefetch in order after them, a
 * concurrency limit, a per-PR cap, shared reads, size limits, and pauses for input, hidden windows and rate limits.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(options: Parameters<typeof createSyntaxContentsScheduler>[0] = {}) {
  let clock = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  const scheduler = createSyntaxContentsScheduler({
    now: () => clock,
    setTimer: (run, ms) => timers.push({ at: clock + ms, run }),
    ...options,
  });
  const started: string[] = [];
  /** The tier of every call to a job's `run`, in order, as `key:tier`. */
  const tiers: string[] = [];
  const open = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const job = (key: string, extra: Partial<SyntaxContentsJob> = {}): SyntaxContentsJob => ({
    key,
    pr: 'https://github.com/a/b/pull/1',
    run: (tier: SyntaxContentsTier) => {
      tiers.push(`${key}:${tier}`);
      // A promotion's second call joins the read in flight, as main joins the two IPC requests.
      if (open.has(key)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        started.push(key);
        open.set(key, { resolve, reject });
      });
    },
    ...extra,
  });
  const finish = async (key: string, error?: Error) => {
    const read = open.get(key);
    assert.ok(read, `${key} is running`);
    open.delete(key);
    if (error) read.reject(error);
    else read.resolve();
    await flush();
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at))
      if (timer.at <= clock) timer.run();
      else timers.push(timer);
    await flush();
  };
  return { scheduler, job, started, tiers, finish, advance, running: () => [...open.keys()] };
}

void test('View reads run two at a time, newest first, and share one read per file', async () => {
  const { scheduler, job, started, finish, running } = harness();
  let done = 0;
  for (const key of ['a', 'b', 'c', 'd']) scheduler.request(job(key), () => done++);
  // A second view of a queued file joins it.
  scheduler.request(job('d'), () => done++);
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(scheduler.stats().running, 2);
  await finish('a');
  assert.deepEqual(started, ['a', 'b', 'd'], 'The newest request goes next');
  await finish('d');
  assert.equal(done, 3, 'Both views of d heard back');
  await finish('b');
  await finish('c');
  assert.deepEqual(running(), []);
  assert.equal(scheduler.stats().peak, 2);
  // A file read before is read again only by asking (its contents left the cache), and costs no cap.
  scheduler.request(job('a', { ready: () => true }), () => done++);
  assert.equal(done, 6, 'Cached contents answer without a read');
  assert.equal(started.length, 4);
});

void test('A view read withdrawn before it starts is never sent', async () => {
  const { scheduler, job, started, finish } = harness();
  scheduler.request(job('a'), () => {});
  scheduler.request(job('b'), () => {});
  const cancel = scheduler.request(job('c'), () => {});
  cancel();
  await finish('a');
  await finish('b');
  assert.deepEqual(started, ['a', 'b']);
});

void test('The per-PR cap counts distinct files; other PRs and revisits are not capped', async () => {
  const { scheduler, job, started, finish } = harness({ perPr: 2, concurrency: 1 });
  scheduler.request(job('a'), () => {});
  await finish('a');
  scheduler.request(job('b'), () => {});
  await finish('b');
  scheduler.request(job('c'), () => {});
  assert.deepEqual(started, ['a', 'b'], 'The third file of the PR is past the cap');
  scheduler.request(job('a'), () => {});
  assert.deepEqual(started, ['a', 'b', 'a'], 'A file already read is not a new one');
  await finish('a');
  scheduler.request(job('x', { pr: 'https://github.com/a/b/pull/2' }), () => {});
  assert.deepEqual(started.at(-1), 'x');
  await finish('x');
  // The PR leaves the inspection caches: its cap starts over.
  scheduler.forget(new Set(['https://github.com/a/b/pull/1']));
  scheduler.request(job('c'), () => {});
  assert.equal(started.at(-1), 'c');
});

void test('A forgotten PR’s prefetch reads that have not started are dropped; a view read and reads in flight stay', async () => {
  const { scheduler, job, started, finish } = harness({ concurrency: 1 });
  const other = job('x').pr.replace(/1$/, '2');
  scheduler.prefetch('predicted', [job('a'), job('b'), job('c'), job('x', { pr: other })], 1);
  let viewed = 0;
  scheduler.request(job('c'), () => viewed++);
  assert.deepEqual(started, ['a'], 'One read at a time');
  scheduler.forget(new Set([job('a').pr]));
  assert.equal(scheduler.stats().queued, 2, 'b leaves the queue; c, which a view waits for, and the other PR’s x stay');
  await finish('a');
  await finish('c');
  assert.equal(viewed, 1);
  await finish('x');
  assert.deepEqual(started, ['a', 'c', 'x'], 'b is never read');
});

void test('Files too large, and files whose read failed, are not read again', async () => {
  const { scheduler, job, started, finish } = harness();
  scheduler.request(job('big', { characters: SYNTAX_CONTENTS_MAX_CHARACTERS + 1 }), () => {});
  assert.deepEqual(started, []);
  scheduler.request(job('binary'), () => {});
  await finish('binary', Error('This binary file has no text preview. Open it on GitHub.'));
  scheduler.request(job('binary'), () => {});
  assert.deepEqual(started, ['binary']);
});

void test('A rate limit pauses every read until GitHub accepts requests again', async () => {
  const { scheduler, job, started, finish, advance } = harness({ concurrency: 1 });
  scheduler.request(job('a'), () => {});
  scheduler.request(job('b'), () => {});
  const resume = new Date(1_000 + 30_000).toISOString();
  await finish('a', Error(`Error invoking remote method: GitHub’s API limit was reached. GitHub requests can resume after ${resume}.`));
  assert.deepEqual(started, ['a'], 'Nothing runs during the pause');
  await advance(29_000);
  assert.deepEqual(started, ['a']);
  await advance(1_000);
  assert.deepEqual(started, ['a', 'b'], 'Reads resume after the pause');
  await finish('b');
  assert.deepEqual(started, ['a', 'b', 'a'], 'The limited file is read again');
  assert.equal(backoffUntil(Error('Not Found'), 0), undefined);
  assert.equal(backoffUntil(Error('secondary rate limit'), 0), 60_000);
});

void test('Prefetch runs in order after view reads, and a view read takes over a waiting prefetch', async () => {
  const { scheduler, job, started, finish } = harness();
  scheduler.prefetch('open', ['p1', 'p2', 'p3', 'p4', 'p5'].map((key) => job(key)));
  assert.deepEqual(started, ['p1', 'p2']);
  // The reader scrolls to p5 and to v: both go before p3 and p4.
  let p5 = 0;
  scheduler.request(job('v'), () => {});
  scheduler.request(job('p5'), () => p5++);
  await finish('p1');
  await finish('p2');
  assert.deepEqual(started, ['p1', 'p2', 'p5', 'v']);
  await finish('p5');
  assert.equal(p5, 1);
  await finish('v');
  assert.deepEqual(started, ['p1', 'p2', 'p5', 'v', 'p3', 'p4']);
  assert.deepEqual(
    scheduler.stats().log.map((entry) => entry.tier),
    ['prefetch', 'prefetch', 'view', 'view', 'prefetch', 'prefetch']
  );
});

void test('The predicted PR’s files wait behind the open PR’s; closing the view stops its prefetch', async () => {
  const { scheduler, job, started, finish } = harness({ concurrency: 1 });
  scheduler.prefetch('predicted', [job('n1', { pr: 'next' }), job('n2', { pr: 'next' })], 1);
  const stop = scheduler.prefetch('open', [job('o1'), job('o2'), job('o3')]);
  assert.deepEqual(started, ['n1'], 'A read that started finishes');
  await finish('n1');
  assert.deepEqual(started, ['n1', 'o1']);
  stop();
  await finish('o1');
  assert.deepEqual(started, ['n1', 'o1', 'n2'], 'o2 and o3 were dropped');
  await finish('n2');
  assert.equal(scheduler.stats().queued, 0);
});

void test('Prefetch pauses while the reader scrolls or types and while the window is hidden; view reads do not', async () => {
  const { scheduler, job, started, finish, advance } = harness({ concurrency: 1 });
  scheduler.pausePrefetch(1_000 + 700);
  scheduler.prefetch('open', [job('p1'), job('p2')]);
  assert.deepEqual(started, [], 'Scrolling: prefetch waits');
  scheduler.request(job('v'), () => {});
  assert.deepEqual(started, ['v'], 'A view read does not wait');
  await finish('v');
  assert.deepEqual(started, ['v']);
  await advance(700);
  assert.deepEqual(started, ['v', 'p1'], 'Prefetch resumes after the pause');
  scheduler.setHidden(true);
  await finish('p1');
  assert.deepEqual(started, ['v', 'p1'], 'Hidden: prefetch waits');
  scheduler.setHidden(false);
  assert.deepEqual(started, ['v', 'p1', 'p2']);
  await finish('p2');
  scheduler.prefetch('open', [job('p3')]);
  scheduler.stopPrefetch();
  await flush();
  assert.equal(started.length, 4, 'p3 started before the stop');
});

void test('The read bound: a 165-file PR prefetches each supported file once, and revisits read nothing', async () => {
  const { scheduler, job, started } = harness();
  const cached = new Set<string>();
  const files = Array.from({ length: 165 }, (_, i) => `f${i}`);
  const jobs = () =>
    files.map((key) =>
      job(key, {
        ready: () => cached.has(key),
        run: () =>
          new Promise<void>((resolve) => {
            started.push(key);
            cached.add(key);
            resolve();
          }),
      })
    );
  scheduler.prefetch('open', jobs());
  for (let i = 0; i < 200 && scheduler.stats().queued; i++) await flush();
  assert.equal(started.length, 165);
  assert.ok(scheduler.stats().peak <= 2);
  // The view is closed and opened again, and every file is scrolled past.
  scheduler.prefetch('open', jobs());
  for (const key of files) scheduler.request(job(key, { ready: () => cached.has(key) }), () => {});
  await flush();
  assert.equal(started.length, 165, 'Cached files are not read again');
});

const file = (path: string, patch: string | undefined, extra: Partial<PrChangeFile> = {}): PrChangeFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  changeId: path,
  patch,
  ...extra,
});
void test('What a file’s scopes need: the after side, both sides for deletion-only hunks, or nothing', () => {
  const change = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d';
  assert.deepEqual(syntaxContentsPlan({}, file('src/a.rs', change)), { both: false, characters: 6 });
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', '@@ -1,3 +1,2 @@\n a\n-b\n d'))?.both, true);
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', `${change}\n@@ -9,2 +9,1 @@\n x\n-y`))?.both, true);
  assert.equal(syntaxContentsPlan({}, file('notes.rb', change)), undefined, 'No grammar');
  assert.equal(syntaxContentsPlan({}, file('logo.svg', change)), undefined, 'An image');
  assert.equal(syntaxContentsPlan({}, file('package-lock.json', change)), undefined, 'Generated');
  assert.equal(
    syntaxContentsPlan({ fileKinds: { 'gen/api.ts': { generated: { value: true, reason: 'x' }, test: { value: false, reason: 'x' } } } }, file('gen/api.ts', change)),
    undefined,
    'Classified as generated'
  );
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', change, { status: 'added' })), undefined, 'Added: no gaps');
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', undefined)), undefined, 'No patch: the view reads it whole');
  const huge = `@@ -1,1 +1,1 @@\n-a\n+${'x'.repeat(SYNTAX_CONTENTS_MAX_CHARACTERS)}`;
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', huge)), undefined, 'The patch alone is too large');
});

void test('Code intelligence settings: saved values are normalized, and a language that is off is never read', () => {
  assert.deepEqual(codeIntelligenceSettings(undefined), { enabled: true, disabled: [] });
  assert.deepEqual(codeIntelligenceSettings({ codeIntelligence: 'yes' }), { enabled: true, disabled: [] });
  assert.deepEqual(
    codeIntelligenceSettings({ codeIntelligence: { enabled: 0, disabled: ['yaml', 'cobol', 'rust', 'rust', 7] } }),
    { enabled: true, disabled: ['rust', 'yaml'] },
    'Unknown languages and repeats are dropped, in Settings order; only false turns the switch off'
  );
  assert.equal(codeIntelligenceSettings({ codeIntelligence: { enabled: false } }).enabled, false);
  const rustOff = withLanguage(DEFAULT_CODE_INTELLIGENCE, 'rust', false);
  assert.deepEqual(rustOff.disabled, ['rust']);
  assert.deepEqual(withLanguage(rustOff, 'rust', true).disabled, []);
  assert.equal(languageEnabled(rustOff, 'rust'), false);
  assert.equal(languageEnabled(rustOff, 'typescript'), true);
  assert.equal(languageEnabled({ enabled: false, disabled: [] }, 'typescript'), false, 'The master switch');
  assert.equal(pathEnabled(rustOff, 'notes.rb'), false, 'No grammar');
  // The effect: no plan, so no view read, no prefetch and nothing to parse.
  const change = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d';
  const allowed = (settings: typeof rustOff) => (path: string) => pathEnabled(settings, path);
  assert.equal(syntaxContentsPlan({}, file('src/a.rs', change), allowed(rustOff)), undefined);
  assert.ok(syntaxContentsPlan({}, file('src/a.ts', change), allowed(rustOff)));
  assert.equal(syntaxContentsPlan({}, file('src/a.ts', change), allowed({ enabled: false, disabled: [] })), undefined);
  // A rename from a language that is off reads only the new side.
  const deletion = '@@ -1,3 +1,2 @@\n a\n-b\n d';
  assert.equal(syntaxContentsPlan({}, file('src/a.ts', deletion, { previousPath: 'src/a.rs' }), allowed(rustOff))?.both, false);
});

void test('View reads go to main at foreground priority, prefetch in the background', async () => {
  // 'view' is foreground: ahead of queue preparation, below the reader's own interactive requests.
  assert.equal(syntaxReadMode('view'), 'view');
  assert.equal(syntaxReadMode('prefetch'), true);
  assert.ok(inspectionRank('view') > inspectionRank(true));
  assert.ok(inspectionRank('view') < inspectionRank(false));
  const { scheduler, job, tiers, finish } = harness({ concurrency: 1 });
  scheduler.request(job('v'), () => {});
  await finish('v');
  scheduler.prefetch('open', [job('p')]);
  await finish('p');
  assert.deepEqual(tiers, ['v:view', 'p:prefetch']);
});

void test('A view request promotes a prefetch read in flight; the cache sends the view request beside it', async () => {
  const { scheduler, job, started, tiers, finish } = harness({ concurrency: 1 });
  scheduler.prefetch('open', [job('p1'), job('p2')]);
  assert.deepEqual(tiers, ['p1:prefetch']);
  let heard = 0;
  scheduler.request(job('p1'), () => heard++);
  assert.deepEqual(tiers, ['p1:prefetch', 'p1:view'], 'The running read is asked for again at view priority');
  assert.deepEqual(started, ['p1'], 'No second read takes a slot');
  scheduler.request(job('p1'), () => heard++);
  assert.equal(tiers.length, 2, 'A read is promoted once');
  await finish('p1');
  assert.equal(heard, 2, 'Both view requests hear back');
  const stats = scheduler.stats();
  assert.equal(stats.promotions, 1);
  assert.deepEqual(
    { tier: stats.log[0].tier, promoted: stats.log[0].promoted, outcome: stats.log[0].outcome },
    { tier: 'view', promoted: true, outcome: 'done' }
  );

  // The file cache: a view read does not wait behind a background read of the same file; it sends its own, which
  // main joins and raises. Later reads of the same or a lower rank share them.
  const loads: InspectionMode[] = [];
  const side: PrFileSide = { kind: 'text', content: 'x' };
  const releases: (() => void)[] = [];
  const cache = createPrFileCache(
    () => Promise.reject(Error('Whole files are not read here')),
    1_000_000,
    (_request, mode = false) => {
      loads.push(mode);
      return new Promise((resolve) => releases.push(() => resolve(side)));
    }
  );
  const request = { url: 'https://github.com/a/b/pull/1', path: 'a.ts', baseSha: 'b', headSha: 'h' };
  const reads = [
    cache.readAfter(request, true),
    cache.readAfter(request, 'view'),
    cache.readAfter(request, 'view'),
    cache.readAfter(request, true),
  ];
  assert.deepEqual(loads, [true, 'view'], 'One background and one view request; later ones join');
  for (const release of releases) release();
  for (const read of reads) assert.deepEqual(await read, side);
});

void test('Transient failures are tried again after 1 s, 4 s and 15 s, then the file fails until asked again', async () => {
  const { scheduler, job, started, finish, advance } = harness();
  let done = 0;
  const failures: SyntaxContentsFailure[] = [];
  scheduler.request(job('a'), () => done++, (failure) => failures.push(failure));
  await finish('a', Error('Error invoking remote method: Request timed out'));
  assert.deepEqual(started, ['a']);
  await advance(999);
  assert.deepEqual(started, ['a'], 'The second try waits a second');
  await advance(1);
  assert.deepEqual(started, ['a', 'a']);
  await finish('a', Error('GitHub returned 502 Bad Gateway'));
  await advance(3_999);
  assert.equal(started.length, 2, 'The third waits four seconds');
  await advance(1);
  assert.equal(started.length, 3);
  await finish('a', Error('net::ERR_NETWORK_CHANGED'));
  await advance(14_999);
  assert.equal(started.length, 3, 'The fourth waits fifteen seconds');
  await advance(1);
  assert.equal(started.length, 4);
  await finish('a', Error('socket hang up'));
  assert.equal(done, 0);
  assert.deepEqual(failures, [{ message: 'socket hang up', retryable: true }], 'The tries ran out');
  await advance(60_000);
  assert.equal(started.length, 4, 'No fifth try');
  assert.deepEqual(scheduler.failure('a'), { message: 'socket hang up', retryable: true });
  // Asking again is refused at once until `retry`; then the file is read with a fresh set of tries.
  const again: SyntaxContentsFailure[] = [];
  scheduler.request(job('a'), () => done++, (failure) => again.push(failure));
  assert.equal(again.length, 1);
  scheduler.retry('a');
  assert.equal(scheduler.failure('a'), undefined);
  scheduler.request(job('a'), () => done++);
  assert.equal(started.length, 5);
  await finish('a');
  assert.equal(done, 1);
  const [first, second] = scheduler.stats().log;
  assert.deepEqual({ attempts: first.attempts, outcome: first.outcome }, { attempts: 4, outcome: 'failed' });
  assert.deepEqual({ attempts: second.attempts, outcome: second.outcome }, { attempts: 1, outcome: 'done' });
  assert.equal(scheduler.stats().retries, 3);
});

void test('A read that fails twice and then succeeds ends with its contents; a view request skips the wait', async () => {
  const { scheduler, job, started, finish, advance } = harness();
  let done = 0;
  scheduler.request(job('a'), () => done++);
  await finish('a', Error('Request timed out'));
  await advance(1_000);
  await finish('a', Error('HTTP 503'));
  // The reader scrolls back to the file: its read goes now, not after four seconds.
  scheduler.request(job('a'), () => done++);
  assert.equal(started.length, 3);
  await finish('a');
  assert.equal(done, 2);
  const [record] = scheduler.stats().log;
  assert.deepEqual({ attempts: record.attempts, outcome: record.outcome }, { attempts: 3, outcome: 'done' });
  assert.ok(record.runMs !== undefined && record.runMs >= 1_000, 'Run time includes the waits between tries');
});

void test('Permanent failures (too large, binary, not text, missing) fail at once; others are transient', async () => {
  for (const message of [
    'This file is too large to preview. Open it on GitHub.',
    'This binary file has no text preview. Open it on GitHub.',
    'This file is not UTF-8 text. Open it on GitHub.',
    'Error invoking remote method: HttpError: Not Found',
    'Request failed with status 404',
    'Reload this PR’s file list before opening the file.',
  ])
    assert.equal(permanentFailure(Error(message)), true, message);
  for (const message of [
    'Request timed out',
    'net::ERR_INTERNET_DISCONNECTED',
    'GitHub returned 502 Bad Gateway',
    'HttpError: Server Error (500)',
    'fetch failed',
  ])
    assert.equal(permanentFailure(Error(message)), false, message);
  const { scheduler, job, started, finish, advance } = harness();
  const failures: SyntaxContentsFailure[] = [];
  scheduler.request(job('missing'), () => {}, (failure) => failures.push(failure));
  await finish('missing', Error('HttpError: Not Found'));
  await advance(30_000);
  assert.deepEqual(started, ['missing'], 'Not tried again');
  assert.equal(failures[0].retryable, false);
  scheduler.retry('missing');
  scheduler.request(job('missing'), () => {});
  assert.deepEqual(started, ['missing'], 'Asking again does not read a file that cannot be read');
  // Too large for the parser: refused without a read, and not retryable.
  const refused: SyntaxContentsFailure[] = [];
  scheduler.request(job('big', { characters: SYNTAX_CONTENTS_MAX_CHARACTERS + 1 }), () => {}, (f) => refused.push(f));
  assert.equal(refused[0]?.retryable, false);
});

void test('Diagnostics: each read records its tier, wait, run time, tries and outcome; slow reads are listed', async () => {
  const { scheduler, job, finish, advance } = harness({ concurrency: 1 });
  scheduler.request(job('a'), () => {});
  scheduler.request(job('b'), () => {});
  await advance(2_500);
  await finish('a');
  await advance(100);
  await finish('b');
  const [a, b] = scheduler.stats().log;
  assert.deepEqual(a, { key: 'a', tier: 'view', queuedMs: 0, runMs: 2_500, attempts: 1, outcome: 'done' });
  assert.deepEqual(b, { key: 'b', tier: 'view', queuedMs: 2_500, runMs: 100, attempts: 1, outcome: 'done' });
  const report = syntaxContentsDiagnostics(scheduler.stats());
  assert.deepEqual(report.slow.map((read) => read.key), ['a', 'b']);
  assert.equal(report.recent.length, 2);
  assert.equal(report.reads, 2);
});
