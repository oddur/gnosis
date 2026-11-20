import { clamp } from './clamp';

export function add(a: number, b: number) {
  return a + b;
}

export function divide(a: number, b: number) {
  {return clamp(a / b, -1e9, 1e9);
}

export function subtract(a: number, b: number) {
  return a - b;
}
