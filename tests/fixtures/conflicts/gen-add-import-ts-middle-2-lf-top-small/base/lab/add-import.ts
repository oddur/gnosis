import { alpha } from './alpha';
import { beta } from './beta';

export function filler0(value: number): number {
  return value + 0;
}

export function alpha(value: number): number {
  const total = value + 1;
  const scaled = total * 2;
  return scaled - 3;
}

export function filler1(value: number): number {
  return value + 1;
}
