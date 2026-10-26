export function calculateBackoff(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random = Math.random
): number {
  const base = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.max(0, attempt - 1)));
  const spread = base * Math.max(0, Math.min(1, jitterRatio));
  return Math.max(0, Math.round(base - spread + random() * spread * 2));
}
