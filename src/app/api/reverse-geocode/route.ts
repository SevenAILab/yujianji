import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ALPHA2_TO_ALPHA3 } from "@/lib/iso";
import { allowRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const requestSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

const providerSchema = z.object({
  display_name: z.string().optional(),
  address: z.object({
    city: z.string().optional(),
    town: z.string().optional(),
    village: z.string().optional(),
    municipality: z.string().optional(),
    county: z.string().optional(),
    state: z.string().optional(),
    country_code: z.string().optional(),
  }).passthrough().optional(),
});

type ReverseResult = {
  place: string;
  displayName: string;
  country?: string;
};

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const cache = new Map<string, { expiresAt: number; result: ReverseResult }>();

function cacheKey(lat: number, lng: number) {
  return createHash("sha256").update(`${lat.toFixed(4)}:${lng.toFixed(4)}`).digest("hex");
}

export async function POST(request: Request) {
  if (!allowRequest(30, "reverse-geocode")) {
    return NextResponse.json({ code: "RATE_LIMITED", error: "地点查询太频繁，请稍后再试" }, { status: 429 });
  }

  let body: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1_024) {
      return NextResponse.json({ code: "REQUEST_TOO_LARGE", error: "坐标信息过长" }, { status: 413 });
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ code: "INVALID_REQUEST", error: "坐标格式不正确" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_REQUEST", error: "坐标格式不正确" }, { status: 400 });
  }

  const key = cacheKey(parsed.data.lat, parsed.data.lng);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ...cached.result, cached: true });
  }

  try {
    const baseUrl = process.env.GEOCODING_BASE_URL ?? "https://nominatim.openstreetmap.org";
    const url = new URL("/reverse", baseUrl);
    url.searchParams.set("lat", String(parsed.data.lat));
    url.searchParams.set("lon", String(parsed.data.lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "10");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(url, {
      headers: {
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "user-agent": process.env.GEOCODING_USER_AGENT ?? "yujianji/0.1 (+https://github.com/SevenAILab/yujianji)",
      },
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error("reverse geocoder failed");

    const provider = providerSchema.parse(await response.json());
    const address = provider.address;
    const locality = address?.city ?? address?.town ?? address?.village ?? address?.municipality ?? address?.county;
    const place = [address?.state, locality].filter((part, index, parts) => part && parts.indexOf(part) === index).join(" · ") || provider.display_name?.split(",").slice(0, 2).join(" · ") || "位置已识别";
    const alpha2 = address?.country_code?.toUpperCase();
    const result: ReverseResult = {
      place,
      displayName: provider.display_name ?? place,
      ...(alpha2 && ALPHA2_TO_ALPHA3[alpha2] ? { country: ALPHA2_TO_ALPHA3[alpha2] } : {}),
    };
    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ ...result, cached: false });
  } catch {
    return NextResponse.json({ code: "GEOCODER_UNAVAILABLE", error: "地点暂时无法识别" }, { status: 502 });
  }
}
