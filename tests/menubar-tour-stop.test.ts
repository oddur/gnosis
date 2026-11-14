import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menubarShowBlocked, menubarTourFallback, offerMenubarTourStop } from '../lib/desktop-setup';

const panel = { trayEnabled: true, menubarSettings: { click: 'panel' } };
const offer = (extra: Partial<Parameters<typeof offerMenubarTourStop>[0]> = {}) =>
  offerMenubarTourStop({ platform: 'darwin', local: false, prefs: panel, desktop: undefined, ...extra });

void test('the walkthrough ends at the menu bar on macOS with the icon on in panel mode', () => {
  assert.equal(offer(), true);
  // The default click is the panel.
  assert.equal(offer({ prefs: { trayEnabled: true } }), true);
  // Skipped or "No" in setup's menu bar step: the stop still teaches the panel.
  assert.equal(offer({ desktop: { menubar: 'skipped' } }), true);
  assert.equal(offer({ desktop: { menubar: 'not-seen', notifications: 'completed' } }), true);
});

void test('the stop is left out off macOS, in local mode, without the panel, and after setup showed the icon', () => {
  assert.equal(offer({ platform: 'win32' }), false);
  assert.equal(offer({ platform: 'linux' }), false);
  assert.equal(offer({ local: true }), false);
  assert.equal(offer({ prefs: { trayEnabled: false } }), false, 'icon off');
  assert.equal(offer({ prefs: { trayEnabled: true, menubarSettings: { click: 'menu' } } }), false, 'classic menu');
  assert.equal(offer({ prefs: null }), false, 'preferences not loaded');
  assert.equal(offer({ desktop: { menubar: 'completed' } }), false, 'already completed in setup');
});

void test('Show me and the stop share one reading of the platform and settings', () => {
  assert.equal(menubarShowBlocked('darwin', panel), undefined);
  assert.equal(menubarShowBlocked('win32', panel), 'unsupported');
  assert.equal(menubarShowBlocked('darwin', { trayEnabled: false }), 'off');
  assert.equal(menubarShowBlocked('darwin', { trayEnabled: true, menubarSettings: { click: 'menu' } }), 'menu');
  // An unknown click value falls back to the panel, as Settings does.
  assert.equal(menubarShowBlocked('darwin', { trayEnabled: true, menubarSettings: { click: 'popover' } }), undefined);
});

void test('when Show me cannot open the panel, the stop says why', () => {
  assert.equal(menubarTourFallback('shown'), undefined);
  assert.match(menubarTourFallback('hidden') ?? '', /macOS is hiding the icon/);
  assert.match(menubarTourFallback('off') ?? '', /Integrations/);
  assert.match(menubarTourFallback('menu') ?? '', /summary panel/);
});

void test('walkthrough progress can rest on the menu bar stop', async () => {
  const { createOnboardingService, TOUR_LAST_STEP } = await import('../src/onboarding-service');
  const data = new Map<string, unknown>();
  const service = createOnboardingService({
    storage: { read: (key) => data.get(key), write: (key, value) => void data.set(key, value), flush: () => Promise.resolve() },
    account: () => 'alice',
    preferences: () => ({}) as never,
    savePreferences: () => {},
    views: () => ({ views: [] }) as never,
    replaceViews: () => {},
  });
  assert.equal(TOUR_LAST_STEP, 4);
  await service.save({ tourStep: 4 }, 'alice');
  assert.equal(service.load().tourStep, 4);
  await service.save({ tourStep: 9 }, 'alice');
  assert.equal(service.load().tourStep, 4);
});
