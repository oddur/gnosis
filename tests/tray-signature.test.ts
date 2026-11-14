import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateSignature, createTrayMenuSignature } from '../src/tray-signature';

const menu = (label: string) => [
  { label, submenu: [{ label: 'Open Review', click: () => undefined }] },
  { type: 'separator' },
  { label: 'Quit Gnosis', click: () => undefined },
];
void test('skips an unchanged menu', () => {
  const signature = createTrayMenuSignature();
  assert.equal(signature.changed(menu('PR 1'), [['r1', 'https://github.com/o/r/pull/1']]), true);
  assert.equal(
    signature.changed(menu('PR 1'), [['r1', 'https://github.com/o/r/pull/1']]),
    false,
    'New click handlers alone do not rebuild the menu'
  );
  assert.equal(signature.changed(menu('PR 1 (2 failed)'), [['r1', 'https://github.com/o/r/pull/1']]), true);
  assert.equal(
    signature.changed(menu('PR 1 (2 failed)'), [['r2', 'https://github.com/o/r/pull/1']]),
    true,
    'An entry that opens another review is a change'
  );
  signature.reset();
  assert.equal(
    signature.changed(menu('PR 1 (2 failed)'), [['r2', 'https://github.com/o/r/pull/1']]),
    true,
    'A new tray gets a menu'
  );
});

void test('the state signature skips a value equal to the last one', () => {
  const signature = createStateSignature();
  assert.equal(signature.changed({ rows: [1, 2], line: '2 need you' }), true);
  assert.equal(signature.changed({ rows: [1, 2], line: '2 need you' }), false);
  assert.equal(signature.changed({ rows: [2, 1], line: '2 need you' }), true);
  signature.reset();
  assert.equal(signature.changed({ rows: [2, 1], line: '2 need you' }), true, 'A new panel gets the state again');
});
