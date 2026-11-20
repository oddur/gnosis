export function legacyTotal(xs: number[]) {
  return xs.filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

export function total(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}
