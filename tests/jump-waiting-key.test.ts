import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { beginJump, dropWaitingKey, jumpEnds, jumpOnItsWay, jumpTakesOff, whenJumpLands } from '../lib/tree-symbol-sync';

/** A V or Enter pressed while a jump is on its way waits for it (lib/tree-symbol-sync.ts), and is never lost. */

const pressDuringJump = () => {
  const jump = beginJump();
  jumpTakesOff(jump);
  assert.equal(jumpOnItsWay(), true);
  let ran = 0;
  whenJumpLands(() => ran++);
  return { jump, ran: () => ran };
};

void test('the key runs when its jump lands', () => {
  const { jump, ran } = pressDuringJump();
  jumpEnds(jump, 'landed');
  assert.equal(ran(), 1);
  assert.equal(jumpOnItsWay(), false);
});

void test("the reader's own scroll drops it", () => {
  const { jump, ran } = pressDuringJump();
  jumpEnds(jump, 'stopped');
  assert.equal(ran(), 0);
});

void test('a jump that ends another way (its diff re-rendered, a newer jump took over) still runs it', () => {
  const { jump, ran } = pressDuringJump();
  jumpEnds(jump, 'over');
  assert.equal(ran(), 1);
});

void test('a new navigation drops it', () => {
  const { jump, ran } = pressDuringJump();
  dropWaitingKey();
  jumpEnds(jump, 'landed');
  assert.equal(ran(), 0);
});

void test('the end of an older jump leaves the newer one, and its key, alone', () => {
  const older = beginJump();
  jumpTakesOff(older);
  const { jump, ran } = pressDuringJump();
  jumpEnds(older, 'over');
  assert.equal(ran(), 0);
  jumpEnds(jump, 'landed');
  assert.equal(ran(), 1);
});

void test('a jump that never ends cannot hold the key: it runs after JUMP_WAIT_MS', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { ran } = pressDuringJump();
    mock.timers.tick(4_999);
    assert.equal(ran(), 0);
    mock.timers.tick(1);
    assert.equal(ran(), 1);
    assert.equal(jumpOnItsWay(), false);
  } finally {
    mock.timers.reset();
  }
});
