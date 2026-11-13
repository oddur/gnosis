import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
const sdkSource = readFileSync(require.resolve('@aptabase/electron/main'), 'utf8');

// Keep the real main-process statement order and real SDK. Importing the entire
// main process would also start windows, GitHub polling, and agent services.
const declarations = new Set([
  'APTABASE_APP_KEY',
  'aptabaseInitialized',
  'DEFAULT_PREFERENCES',
  'getPreferencesPath',
  'loadPreferences',
  'preferencesFile',
  'readPreferencesFile',
  'enableAnalyticsIfAllowed',
]);
const startup = source.statements
  .filter((node) => {
    if (ts.isFunctionDeclaration(node)) return declarations.has(node.name?.text ?? '');
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.some((d) => declarations.has(d.name.getText(source)));
    return (
      !ts.isImportDeclaration(node) &&
      !node.getText(source).includes('app.whenReady()') &&
      node.getText(source).includes('initAptabase(')
    );
  })
  .map((node) => node.getText(source))
  .join('\n');
const readyHandler = source.statements.find(
  (node) =>
    node.getText(source).includes('app.whenReady().then') && node.getText(source).includes("trackEvent('app_started')")
);
assert.ok(readyHandler, 'Launch tracking must be wired into app readiness');
const readyStatements: string[] = [];
function collect(node: ts.Node) {
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
    for (const statement of node.body.statements) {
      const text = statement.getText(source);
      if (
        text === 'const prefs = loadPreferences();' ||
        text.includes('enableAnalyticsIfAllowed(prefs)') ||
        text.includes("trackEvent('app_started')")
      )
        readyStatements.push(text);
    }
  } else ts.forEachChild(node, collect);
}
collect(readyHandler);
const compile = (code: string) =>
  ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

type Event = { eventName: string; systemProps: { isDebug: boolean }; props?: unknown };
async function launch(stored: string | undefined, packaged = true, platform: NodeJS.Platform = 'linux') {
  let ready = false;
  let resolveReady!: () => void;
  const readiness = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const warnings: string[] = [];
  const events: Event[] = [];
  const electron = {
    app: {
      isReady: () => ready,
      whenReady: () => readiness,
      isPackaged: packaged,
      getVersion: () => '0.32.0',
      getLocale: () => 'en',
      getPath: () => '/fixture',
    },
    ipcMain: { on() {} },
    protocol: { registerSchemesAsPrivileged() {}, registerStringProtocol() {} },
    net: {
      request({ url }: { url: string }) {
        assert.equal(url, 'https://eu.aptabase.com/api/v0/event');
        let respond!: (response: { statusCode: number }) => void;
        return {
          setHeader(name: string, value: string) {
            if (name === 'App-Key') assert.equal(value, 'A-EU-7599830434');
          },
          on(name: string, fn: typeof respond) {
            if (name === 'response') respond = fn;
          },
          write(body: string) {
            events.push(JSON.parse(body) as Event);
          },
          end() {
            respond({ statusCode: 200 });
          },
        };
      },
    },
  };
  const sdkModule = {
    exports: {} as { initialize: (key: string) => Promise<void>; trackEvent: (name: string) => Promise<void> },
  };
  vm.runInNewContext(sdkSource, {
    module: sdkModule,
    exports: sdkModule.exports,
    process: { ...process, platform },
    console: { warn: (text: string) => warnings.push(text), error: (text: string) => warnings.push(text) },
    require(name: string) {
      if (name === 'electron') return electron;
      if (name === 'fs')
        return {
          readFile(_file: string, _encoding: string, callback: (error: null, data: string) => void) {
            void setImmediate()
              .then(() => setImmediate())
              .then(() => callback(null, 'NAME="Linux"\nVERSION_ID="24.04"'));
          },
        };
      if (name === 'child_process')
        return {
          exec(_command: string, callback: (error: null, stdout: string) => void) {
            callback(null, '15.0');
          },
        };
      return require(name) as unknown;
    },
  });
  const initialization: Promise<void>[] = [];
  const context = vm.createContext({
    app: electron.app,
    path,
    initAptabase(key: string) {
      const pending = sdkModule.exports.initialize(key);
      initialization.push(pending);
      return pending;
    },
    trackEvent: sdkModule.exports.trackEvent,
    fs: {
      readFileSync() {
        if (stored === undefined) throw Error('No saved preferences');
        return stored;
      },
    },
    // Each read parses the stored preferences again; the stat cache has its own tests.
    createStatCache: (_file: unknown, read: (exists: boolean) => unknown) => ({
      get: () => read(true),
      set() {},
      clear() {},
    }),
    deepFreeze: (value: unknown) => value,
    timed: (_label: string, fn: () => unknown) => fn(),
    structuredClone,
    DEFAULT_GITHUB_CACHE_MB: 512,
    DEFAULT_PR_INACTIVITY_DAYS: 30,
    DEFAULT_CLAUDE_MODEL: 'opus',
    DEFAULT_FAST_CLAUDE_MODEL: 'sonnet',
    normalizeRepositorySettings: () => ({}),
    normalizeLocalExplanationPreferences: () => ({}),
    normalizeBriefingLimit: () => 10,
    normalizeGitHubCacheMB: () => 512,
    normalizePrInactivityDays: () => 30,
    normalizePreloadPreferences: () => ({ predictNavigation: true, preloadAmount: 'normal', prepareQueue: true, preloadBudgetPercent: 6 }),
    normalizeModelSelection: () => ({ provider: 'claude', model: 'opus' }),
    normalizeEffort: () => 'high',
  });
  vm.runInContext(compile(startup), context);
  assert.equal(events.length, 0, 'SDK initialization itself must not send events');
  ready = true;
  resolveReady();
  vm.runInContext(compile(readyStatements.join('\n')), context);
  // OS metadata may require asynchronous file I/O on Linux. Wait for the SDK,
  // not an arbitrary event-loop turn, before asserting queued event delivery.
  await Promise.all(initialization);
  assert.deepEqual(warnings, [], 'SDK must initialize before Electron is ready');
  return events;
}

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  for (const [name, stored] of [
    ['first launch', undefined],
    ['saved opt-in', '{"analytics":true}'],
    ['invalid preferences', '{'],
  ] as const) {
    void test(`production analytics sends a launch event with ${name} on ${platform}`, async () => {
      const events = await launch(stored, true, platform);
      assert.equal(events.length, 1);
      assert.equal(events[0].eventName, 'app_started');
      assert.equal(events[0].systemProps.isDebug, false);
      assert.equal(events[0].props, undefined);
    });
  }
  void test(`opt-out sends no launch event on ${platform}`, async () => {
    assert.deepEqual(await launch('{"analytics":false}', true, platform), []);
  });
  void test(`development launches are marked as debug on ${platform}`, async () => {
    const events = await launch(undefined, false, platform);
    assert.equal(events.length, 1);
    assert.equal(events[0].systemProps.isDebug, true);
  });
}
