export const LIMITS = {
  retries: 3,
  timeout: 60_000,
};

export function describe() {
  return `retries=${LIMITS.retries}`;
}
