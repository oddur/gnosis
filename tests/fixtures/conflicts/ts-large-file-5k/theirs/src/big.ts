import { clamp } from './clamp';

// @@PAD 2600 1@@
export function add(a: number, b: number) {
  return a + b;
}

export function divide(a: number, b: number) {
  return clamp(a / b, -1e9, 1e9);
}

// @@PAD 2600 2@@
