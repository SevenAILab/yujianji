import type { Position } from "./geo";

export async function readImageLocation(file: File): Promise<Position | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const exifr = await import("exifr");
    const readGps = exifr.gps ?? exifr.default.gps;
    const result = await readGps(file);
    if (
      !result ||
      !Number.isFinite(result.latitude) ||
      !Number.isFinite(result.longitude) ||
      result.latitude < -90 ||
      result.latitude > 90 ||
      result.longitude < -180 ||
      result.longitude > 180
    ) {
      return null;
    }
    return { lat: result.latitude, lng: result.longitude };
  } catch {
    return null;
  }
}
