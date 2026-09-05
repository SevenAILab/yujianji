import type { DateSource } from "./types";

export function normalizeCapturedDate(
  exifDate: Date | null,
  modifiedDate: Date | null,
  now = new Date(),
): { date: string; source: DateSource } {
  const futureBoundary = now.getTime() + 24 * 60 * 60 * 1000;
  const isPlausible = (value: Date | null) =>
    value !== null &&
    Number.isFinite(value.getTime()) &&
    value.getFullYear() >= 2000 &&
    value.getTime() <= futureBoundary;

  if (isPlausible(exifDate)) {
    return { date: exifDate!.toISOString(), source: "exif" };
  }
  if (isPlausible(modifiedDate)) {
    return { date: modifiedDate!.toISOString(), source: "fileModified" };
  }
  return { date: now.toISOString(), source: "imported" };
}

export async function readImageCapturedDate(
  file: File,
): Promise<{ date: string; source: DateSource }> {
  let exifDate: Date | null = null;
  try {
    const exifr = await import("exifr");
    const parseExif = exifr.parse ?? exifr.default.parse;
    const metadata = (await parseExif(file, {
      pick: ["DateTimeOriginal", "CreateDate"],
      translateValues: false,
    })) as
      | { DateTimeOriginal?: unknown; CreateDate?: unknown }
      | undefined;
    const candidate = metadata?.DateTimeOriginal ?? metadata?.CreateDate;
    if (candidate instanceof Date) exifDate = candidate;
  } catch {
    exifDate = null;
  }

  const modifiedDate =
    Number.isFinite(file.lastModified) && file.lastModified > 0
      ? new Date(file.lastModified)
      : null;
  return normalizeCapturedDate(exifDate, modifiedDate);
}
