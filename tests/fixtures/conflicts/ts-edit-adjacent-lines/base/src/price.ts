export function price(items: number[], tax: number) {
  const subtotal = items.reduce((a, b) => a + b, 0);
  const discount = subtotal > 100 ? 5 : 0;
  const total = (subtotal - discount) * (1 + tax);
  return Math.round(total * 100) / 100;
}
