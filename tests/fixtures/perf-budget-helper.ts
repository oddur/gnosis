import { assertPerf } from './perf-budget-reexport';

export const check = (ms: number) => assertPerf('helper', ms, 10);
