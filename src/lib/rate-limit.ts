const requestTimes: number[] = [];

export function allowRequest(limit = 120): boolean {
  const now = Date.now();
  while (requestTimes[0] && now - requestTimes[0] > 60_000) {
    requestTimes.shift();
  }
  if (requestTimes.length >= limit) return false;
  requestTimes.push(now);
  return true;
}
