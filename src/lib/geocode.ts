import { z } from "zod";
import { ALPHA2_TO_ALPHA3, ALPHA3_TO_ALPHA2 } from "./iso";

export const geocodeRequestSchema = z.object({
  place: z.string().trim().min(2).max(120),
  country: z.string().trim().min(2).max(5).optional(),
});

const providerResultSchema = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string().optional(),
    address: z
      .object({
        country_code: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }),
);

export type GeocodeRequest = z.infer<typeof geocodeRequestSchema>;

export type GeocodeResult =
  | {
      found: true;
      lat: number;
      lng: number;
      displayName: string;
      country?: string;
    }
  | { found: false };

export function countryCodeForProvider(country?: string): string | null {
  if (!country || country === "UNK" || country === "OTHER") return null;
  const upper = country.toUpperCase();
  if (upper.length === 2) return upper.toLowerCase();
  return ALPHA3_TO_ALPHA2[upper]?.toLowerCase() ?? null;
}

export function parseProviderResults(value: unknown): GeocodeResult {
  const parsed = providerResultSchema.safeParse(value);
  if (!parsed.success || !parsed.data.length) return { found: false };

  const first = parsed.data[0];
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return { found: false };
  }

  const alpha2 = first.address?.country_code?.toUpperCase();
  const country = alpha2 ? ALPHA2_TO_ALPHA3[alpha2] : undefined;
  return {
    found: true,
    lat,
    lng,
    displayName: first.display_name ?? "",
    ...(country ? { country } : {}),
  };
}
