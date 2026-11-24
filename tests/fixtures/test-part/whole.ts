// Four plain node:test tests: a file that is not split runs all of them in every shard (tests/unit-shards.test.ts).
import { test } from 'node:test';

for (const name of ['one', 'two', 'three', 'four']) void test(`whole ${name}`, () => {});
