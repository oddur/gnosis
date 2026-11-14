import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLUR_GUARD_MS, createPanelVisibility } from '../lib/menubar-panel-state';

void test('a click shows, a second click hides', () => {
  let now = 1_000;
  const panel = createPanelVisibility(() => now);
  assert.equal(panel.click(), 'show');
  panel.shown();
  assert.equal(panel.visible, true);
  now += 2_000;
  assert.equal(panel.click(), 'hide');
  assert.equal(panel.hidden('click'), true);
  assert.equal(panel.click(), 'show', 'A hide by click needs no guard');
});

void test('the blur race: a click within 250 ms of a blur hide is ignored', () => {
  let now = 1_000;
  const panel = createPanelVisibility(() => now);
  panel.shown();
  // Clicking the icon while open blurs the panel first, then delivers the click.
  assert.equal(panel.hidesOnBlur(false), true);
  assert.equal(panel.hidden('blur'), true);
  now += 40;
  assert.equal(panel.click(), 'ignore');
  now += BLUR_GUARD_MS;
  assert.equal(panel.click(), 'show', 'A later click opens it again');
});

void test('hiding twice reports once; DevTools keep it open on blur', () => {
  const panel = createPanelVisibility(() => 0);
  assert.equal(panel.hidden('escape'), false, 'Already hidden');
  panel.shown();
  assert.equal(panel.hidesOnBlur(true), false);
  assert.equal(panel.hidden('open'), true);
  assert.equal(panel.hidden('open'), false);
  assert.equal(panel.hidesOnBlur(false), false, 'A hidden panel ignores blur');
});
