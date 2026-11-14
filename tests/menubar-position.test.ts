import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelHeight, panelPosition, PANEL_MAX_HEIGHT, PANEL_WIDTH } from '../lib/menubar-position';

/** A 1512 × 982 laptop display with a 24 pt menu bar. */
const laptop = { x: 0, y: 24, width: 1512, height: 958 };
const item = (x: number, y = 0, height = 24) => ({ x, y, width: 30, height });

void test('centred under the status item, 4 pt below the menu bar', () => {
  const at = panelPosition(item(1000), laptop, { width: PANEL_WIDTH, height: 400 });
  assert.deepEqual(at, { x: 1000 + 15 - 180, y: 28, width: 360, height: 400 });
});

void test('clamped 8 pt inside the right and left edges', () => {
  assert.equal(panelPosition(item(1480), laptop).x, 1512 - 8 - 360);
  assert.equal(panelPosition(item(4), laptop).x, 8);
});

void test('a secondary display with a negative origin', () => {
  const left = { x: -1920, y: -200 + 25, width: 1920, height: 1080 - 25 };
  const at = panelPosition({ x: -300, y: -200, width: 30, height: 25 }, left, { width: 360, height: 300 });
  assert.equal(at.x, -300 + 15 - 180);
  assert.equal(at.y, -200 + 25 + 4);
  const edge = panelPosition({ x: -40, y: -200, width: 30, height: 25 }, left);
  assert.equal(edge.x, -8 - 360, 'Clamped to the right edge of the left display, not the main one');
});

void test('a notched display: the taller menu bar comes from the work area', () => {
  const notched = { x: 0, y: 38, width: 1512, height: 944 };
  // An item reports the bar height it sits in, or less; the work area decides.
  assert.equal(panelPosition({ x: 1200, y: 0, width: 30, height: 24 }, notched).y, 38 + 4);
  assert.equal(panelPosition({ x: 1200, y: 0, width: 30, height: 38 }, notched).y, 38 + 4);
});

void test('height fits the content, at most 560, and never below the work area on a small display', () => {
  assert.equal(panelHeight(300, laptop), 300);
  assert.equal(panelHeight(900, laptop), PANEL_MAX_HEIGHT);
  assert.equal(panelHeight(Number.NaN, laptop), PANEL_MAX_HEIGHT);
  const small = { x: 0, y: 24, width: 1024, height: 400 };
  assert.equal(panelHeight(900, small), 400 - 16);
  const at = panelPosition(item(500), small, { width: 360, height: 900 });
  assert.equal(at.y + at.height <= small.y + small.height - 8, true);
});
