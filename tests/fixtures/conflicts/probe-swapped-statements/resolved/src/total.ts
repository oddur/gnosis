export function total(items: number[]) {
  let sum = 0;
  for (const item of items) sum += Math.abs(item);
  const tax = Math.round(sum * 0.2);
  return sum + tax;
}
