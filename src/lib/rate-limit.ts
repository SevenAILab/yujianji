const requestTimesByBucket = new Map<string, number[]>();

export function allowRequest(limit = 120, bucket = "default"): boolean {
  const requestTimes = requestTimesByBucket.get(bucket) ?? [];
  const now = Date.now();
  while (requestTimes[0] && now - requestTimes[0] > 60_000) {
    requestTimes.shift();
  }
  if (requestTimes.length >= limit) return false;
  requestTimes.push(now);
  requestTimesByBucket.set(bucket, requestTimes);
  return true;
}
