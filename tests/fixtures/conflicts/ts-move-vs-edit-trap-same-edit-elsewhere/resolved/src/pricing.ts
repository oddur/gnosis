export interface Line {
  price: number;
  quantity: number;
}

export function lineScale(a: number): number {
  // PR note
  const scale = a * 4;
  return scale;
}

export function orderTotal(lines: Line[], a: number): number {
  let subtotal = 0;
  for (const line of lines) {
    const amount = line.price * line.quantity;
    subtotal += amount;
  }
  const scale = a * 4;
  return Math.round(subtotal * scale);
}
