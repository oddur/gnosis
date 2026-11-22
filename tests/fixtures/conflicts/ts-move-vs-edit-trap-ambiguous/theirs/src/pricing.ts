export interface Line {
  price: number;
  quantity: number;
  taxable: boolean;
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function orderTotal(lines: Line[], taxRate: number): number {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    const amount = line.price * line.quantity;
    subtotal += amount;
    if (line.taxable && amount > 0) tax += amount * taxRate;
  }
  return Math.round(subtotal + tax);
}

export function lineCount(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function describeLines(lines: Line[]): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const label = line.taxable ? 'taxable' : 'exempt';
    const amount = formatPrice(line.price * line.quantity);
    rows.push(`${line.quantity} x ${formatPrice(line.price)} = ${amount} (${label})`);
  }
  rows.sort();
  return rows;
}

export function largestLine(lines: Line[]): Line | undefined {
  let best: Line | undefined;
  for (const line of lines) {
    if (!best || line.price * line.quantity > best.price * best.quantity) best = line;
  }
  return best;
}
