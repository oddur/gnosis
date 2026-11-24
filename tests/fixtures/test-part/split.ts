// Four tests through tests/support/test-part.ts: each part of two runs two of them (tests/unit-shards.test.ts).
import { test } from '../../support/test-part';

for (const name of ['one', 'two', 'three', 'four']) void test(`split ${name}`, () => {});
