import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMOUNT_PLANS,
  effectiveAmount,
  normalizePreloadAmount,
  normalizePreloadBudgetPercent,
  normalizePreloadPreferences,
  preloadSettings,
} from '../lib/preload-settings';

void test('Preloading settings default safely when missing or invalid', () => {
  const defaults = { predictNavigation: true, amount: 'normal', prepareQueue: true, budgetPercent: 6 };
  for (const missing of [undefined, null, 'x', 4, [], {}]) assert.deepEqual(preloadSettings(missing), defaults);
  assert.deepEqual(
    preloadSettings({ predictNavigation: 'no', preloadAmount: 'turbo', prepareQueue: 0, preloadBudgetPercent: 7 }),
    defaults,
    'Only an explicit false turns a switch off; unknown amounts and shares fall back'
  );
  assert.deepEqual(
    preloadSettings({ predictNavigation: false, preloadAmount: 'eager', prepareQueue: false, preloadBudgetPercent: 15 }),
    { predictNavigation: false, amount: 'eager', prepareQueue: false, budgetPercent: 15 }
  );
  for (const invalid of ['6', 6.5, NaN, Infinity, -3, 0, 100, null]) assert.equal(normalizePreloadBudgetPercent(invalid), 6);
  for (const percent of [3, 6, 10, 15]) assert.equal(normalizePreloadBudgetPercent(percent), percent);
  for (const invalid of ['Light', 'EAGER', '', null, 1]) assert.equal(normalizePreloadAmount(invalid), 'normal');
  assert.deepEqual(normalizePreloadPreferences({ preloadAmount: 'light', other: 1 }), {
    predictNavigation: true,
    preloadAmount: 'light',
    prepareQueue: true,
    preloadBudgetPercent: 6,
  });
});

void test('each amount warms files, the graph, check details, logs and stack members as specified', () => {
  assert.deepEqual(AMOUNT_PLANS.light, { files: 1, graph: false, details: false, logs: 0, members: 0 });
  assert.deepEqual(AMOUNT_PLANS.normal, { files: 3, graph: true, details: true, logs: 0, members: 0 }, 'Normal is #290 unchanged');
  assert.deepEqual(AMOUNT_PLANS.eager, { files: 6, graph: true, details: true, logs: 3, members: 2 });
});

void test('battery and the near-cap reduction step down one level, with a floor of Light', () => {
  assert.deepEqual((['light', 'normal', 'eager'] as const).map((amount) => effectiveAmount(amount, false)), ['light', 'normal', 'eager']);
  assert.deepEqual((['light', 'normal', 'eager'] as const).map((amount) => effectiveAmount(amount, true)), ['light', 'light', 'normal']);
});
