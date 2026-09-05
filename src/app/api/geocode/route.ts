import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  countryCodeForProvider,
  geocodeRequestSchema,
  parseProviderResults,
  type GeocodeResult,
} from "@/lib/geocode";
import { allowRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_096;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_PROVIDER_INTERVAL_MS = 1_050;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, { expiresAt: number; result: GeocodeResult }>();
let providerQueue: Promise<void> = Promise.resolve();
let lastProviderRequestAt = 0;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, error: message }, { status });
}

function cacheKey(place: string, country?: string): string {
  return createHash("sha256")
    .update(`${country?.toUpperCase() ?? "*"}:${place.trim().toLocaleLowerCase()}`)
    .digest("hex");
}

function setCached(key: string, result: GeocodeResult) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, {
    result,
    expiresAt: Date.now() + (result.found ? CACHE_TTL_MS : NOT_FOUND_TTL_MS),
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryProvider(place: string, country?: string): Promise<GeocodeResult> {
  const task = providerQueue.then(async () => {
    async function search(countryCode: string | null): Promise<GeocodeResult> {
      const remaining = MIN_PROVIDER_INTERVAL_MS - (Date.now() - lastProviderRequestAt);
      if (remaining > 0) await wait(remaining);

      const baseUrl = process.env.GEOCODING_BASE_URL ?? "https://nominatim.openstreetmap.org";
      const url = new URL("/search", baseUrl);
      url.searchParams.set("q", place);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("limit", "1");
      if (countryCode) url.searchParams.set("countrycodes", countryCode);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        lastProviderRequestAt = Date.now();
        const response = await fetch(url, {
          headers: {
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            "user-agent":
              process.env.GEOCODING_USER_AGENT ??
              "yujianji/0.1 (+https://github.com/SevenAILab/yujianji)",
          },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`geocoder returned ${response.status}`);
        return parseProviderResults(await response.json());
      } finally {
        clearTimeout(timeout);
      }
    }

    return search(countryCodeForProvider(country));
  });

  providerQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function POST(request: Request) {
  if (!allowRequest(30, "geocode")) {
    return errorResponse(429, "RATE_LIMITED", "地点查询太频繁，请稍后再试");
  }

  let body: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "地点信息过长");
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求不是有效 JSON");
  }

  const parsed = geocodeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "地点或国家信息格式不正确");
  }

  const key = cacheKey(parsed.data.place, parsed.data.country);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ...cached.result, cached: true });
  }
  if (cached) cache.delete(key);

  try {
    const result = await queryProvider(parsed.data.place, parsed.data.country);
    setCached(key, result);
    return NextResponse.json({ ...result, cached: false });
  } catch {
    return errorResponse(502, "GEOCODER_UNAVAILABLE", "地点暂时无法解析，请稍后重试");
  }
}
