export function total(items: number[]) {
  let sum = 0;
  const tax = Math.round(sum * 0.2);
  for (const item of items) sum += Math.abs(item);
  return sum + tax;
}
