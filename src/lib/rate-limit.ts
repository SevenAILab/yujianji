/**
 * 单实例内存限流，只给**不花模型钱**的接口用：
 * geocode / reverse-geocode / map-pins / journeys/generate。
 * 它们要么是纯计算，要么打的是免费的公开地点服务，被多打几次不会产生账单。
 *
 * 会花钱的五个接口（recognize / encounter-av / reply / insight / summary）
 * 一律走 `src/lib/api-guard.ts` 的 guard()：那里有设备维度配额、
 * 全站日预算熔断，并且可以接 Redis 做跨实例真限流。
 */
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
