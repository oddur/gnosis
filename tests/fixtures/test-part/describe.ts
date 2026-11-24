// A split file may not use describe: its tests would register outside the part count (tests/unit-shards.test.ts).
import { test } from '../../support/test-part';

void test.describe('group', () => {});
