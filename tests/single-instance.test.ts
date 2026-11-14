import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instancePolicy, linkFromArgv, linkFromInstanceData, linkSchemes, startSingleInstance, type InstanceApp } from '../src/single-instance';

const dev = ['gnosis-dev'];
const packaged = ['gnosis'];

void test('argv: the single argument in this build’s scheme is the link', () => {
  const exe = 'C:\\Users\\me\\AppData\\Local\\gnosis\\app-1.4.0\\gnosis.exe';
  assert.equal(linkFromArgv([exe], packaged), undefined, 'No link');
  assert.equal(linkFromArgv([exe, 'gnosis://pr/oddur/gnosis/160'], packaged), 'gnosis://pr/oddur/gnosis/160');
  assert.equal(linkFromArgv([exe, 'GNOSIS://pr/o/r/1'], packaged), 'GNOSIS://pr/o/r/1', 'The scheme is case-insensitive');
  assert.equal(linkFromArgv([exe, 'gnosis://pr/o/r/1', 'gnosis://pr/o/r/2'], packaged), undefined, 'Two links: take none');
  assert.equal(
    linkFromArgv([exe, '--allow-file-access-from-files', '--original-process-start-time=1', 'gnosis://pr/o/r/1', '--inspect=0.0.0.0:9229'], packaged),
    'gnosis://pr/o/r/1',
    'Switches beside the link are not part of it'
  );
  assert.equal(linkFromArgv([exe, 'gnosis://x" --inspect=0.0.0.0:9229'], packaged), 'gnosis://x" --inspect=0.0.0.0:9229', 'An injected switch stays inside the one link, which the parser then refuses');
  for (const flag of ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete', '--squirrel-firstrun'])
    assert.equal(linkFromArgv([exe, flag, '1.4.0'], packaged), undefined, flag);
  assert.equal(linkFromArgv(['/path/Electron', '/repo', 'gnosis://pr/o/r/1'], dev), undefined, 'Development only answers gnosis-dev');
  assert.equal(linkFromArgv(['/path/Electron', '/repo', 'gnosis-dev://pr/o/r/1'], dev), 'gnosis-dev://pr/o/r/1');
  assert.equal(linkFromArgv(['/path/Electron', '/repo', 'gnosis-devx://pr/o/r/1'], dev), undefined);
});

void test('second-instance reads additionalData.link only', () => {
  assert.equal(linkFromInstanceData({ link: 'gnosis://pr/o/r/1' }), 'gnosis://pr/o/r/1');
  assert.equal(linkFromInstanceData({}), undefined);
  assert.equal(linkFromInstanceData({ link: 7 }), undefined);
  assert.equal(linkFromInstanceData(null), undefined);
  assert.equal(linkFromInstanceData('gnosis://pr/o/r/1'), undefined);
});

void test('the lock is always on when packaged and opt-in in development; only opt-in registers', () => {
  assert.deepEqual(linkSchemes(true), packaged);
  assert.deepEqual(linkSchemes(false), dev);
  assert.deepEqual(instancePolicy(true, {}), { lock: true, register: true });
  assert.deepEqual(instancePolicy(false, {}), { lock: false, register: false });
  assert.deepEqual(instancePolicy(false, { GNOSIS_DEV_PROTOCOL: '1' }), { lock: true, register: true });
  assert.deepEqual(instancePolicy(false, { GNOSIS_SINGLE_INSTANCE: '1' }), { lock: true, register: false }, 'The smoke test locks without registering');
  assert.deepEqual(instancePolicy(true, { GNOSIS_DEV_PROTOCOL: '0' }), { lock: true, register: true });
});

function fakeApp(options: { packaged?: boolean; lock?: boolean } = {}) {
  const listeners = new Map<string, (...args: never[]) => void>();
  const calls: string[] = [];
  let ready: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => (ready = resolve));
  const app: InstanceApp = {
    isPackaged: options.packaged ?? false,
    requestSingleInstanceLock: (data) => (calls.push(`lock ${JSON.stringify(data)}`), options.lock ?? true),
    exit: (code) => void calls.push(`exit ${code}`),
    on: (event, listener) => void listeners.set(event, listener),
    whenReady: () => whenReady,
    setAsDefaultProtocolClient: (scheme, path, args) => (calls.push(`register ${scheme} ${path ?? ''} ${JSON.stringify(args ?? null)}`), true),
  };
  const emit = (event: string, ...args: unknown[]) => (listeners.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args);
  return { app, calls, emit, listeners, ready: () => ready() };
}

void test('the losing instance forwards its link and exits with app.exit(0), not a quit', () => {
  const fake = fakeApp({ packaged: true, lock: false });
  const instance = startSingleInstance(fake.app, { env: {}, argv: ['gnosis.exe', 'gnosis://pr/o/r/1'], execPath: 'gnosis.exe', log: () => {} });
  assert.equal(instance.primary, false);
  assert.deepEqual(fake.calls, ['lock {"link":"gnosis://pr/o/r/1"}', 'exit 0']);
  assert.equal(fake.listeners.size, 0, 'It listens for nothing');
});

void test('the primary buffers links until attached: cold argv, open-url before ready, and second launches', async () => {
  const fake = fakeApp({ packaged: true });
  const instance = startSingleInstance(fake.app, { env: {}, argv: ['gnosis.exe', 'gnosis://pr/o/r/1'], execPath: 'gnosis.exe', log: () => {} });
  assert.equal(instance.primary, true);
  let prevented = 0;
  fake.emit('open-url', { preventDefault: () => prevented++ }, 'gnosis://pr/o/r/2');
  assert.equal(prevented, 1);
  fake.emit('second-instance', {}, ['gnosis.exe', '--rewritten'], 'C:\\', { link: 'gnosis://pr/o/r/3' });
  fake.emit('second-instance', {}, ['gnosis.exe', 'gnosis://pr/o/r/ignored'], 'C:\\', {});
  const received: string[] = [];
  instance.attach({ receive: (raw, source) => received.push(`${source} ${raw}`), show: () => received.push('show') });
  assert.deepEqual(received, ['os gnosis://pr/o/r/1', 'os gnosis://pr/o/r/2', 'os gnosis://pr/o/r/3', 'show'], 'In arrival order; a launch without a link only focuses');
  // After attaching, links go straight through.
  fake.emit('open-url', { preventDefault: () => {} }, 'gnosis://pr/o/r/4');
  assert.equal(received.at(-1), 'os gnosis://pr/o/r/4');
  // Packaged: register the scheme on every launch, with the current exe.
  fake.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.at(-1), 'register gnosis  null');
});

void test('development takes no lock and registers nothing unless opted in', async () => {
  const plain = fakeApp();
  const instance = startSingleInstance(plain.app, { env: {}, argv: ['Electron', '/repo', 'gnosis-dev://pr/o/r/1'], execPath: '/Electron', log: () => {} });
  plain.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain.calls, []);
  assert.deepEqual(instance.schemes, dev);
  const received: string[] = [];
  instance.attach({ receive: (raw) => received.push(raw), show: () => {} });
  assert.deepEqual(received, ['gnosis-dev://pr/o/r/1'], 'A link on the command line always works');

  const opted = fakeApp();
  startSingleInstance(opted.app, { env: { GNOSIS_DEV_PROTOCOL: '1' }, argv: ['Electron', '.'], execPath: '/Electron', log: () => {} });
  opted.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opted.calls[0], 'lock {}');
  assert.match(opted.calls[1], /^register gnosis-dev \/Electron \["\/.+"\]$/, 'Bound to Electron plus the resolved app path');
});
