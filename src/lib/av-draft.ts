import { nanoid } from "nanoid";
import type {
  AvFrame,
  AvResult,
  Item,
  LocationSource,
  PlaceSource,
} from "./types";

export interface AvCoordinate {
  place: string;
  country: string;
  lat: number;
  lng: number;
  source: LocationSource;
}

export interface AvDraft {
  frames: AvFrame[];
  segments: Array<
    Extract<AvResult, { recognized: true }>["segments"][number] & {
      occurrenceId: string;
    }
  >;
  initialPlace: string;
  initialPlaceSource: PlaceSource;
  initialCountry: string;
  coordinate: AvCoordinate | null;
  capturedAt: string;
  dateSource: "fileModified" | "imported";
  truncated: boolean;
}

function normalizedPlace(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[·•,，。.\s\-_/]/g, "");
}

function findMatchingLocation(placeHint: string, items: Item[]): Item | undefined {
  const hint = normalizedPlace(placeHint);
  if (hint.length < 2) return undefined;
  return [...items]
    .sort((a, b) => b.date.localeCompare(a.date))
    .find((item) => {
      const place = normalizedPlace(item.place);
      return (
        item.lat !== null &&
        item.lng !== null &&
        item.locationSource !== "default" &&
        item.locationSource !== "manual" &&
        (place.includes(hint) || hint.includes(place))
      );
    });
}

export function createAvDraft(
  result: Extract<AvResult, { recognized: true }>,
  frames: AvFrame[],
  history: Item[],
  fileLastModified: number,
  placeFallback = "",
  truncated = false,
  detectedLocation?: AvCoordinate | null,
): AvDraft {
  const previous = [...history].sort((a, b) => b.date.localeCompare(a.date))[0];
  const placeHint = result.placeHint?.trim() ?? "";
  const fallbackPlace = placeFallback.trim();
  const matched = placeHint
    ? findMatchingLocation(placeHint, history)
    : fallbackPlace
      ? findMatchingLocation(fallbackPlace, history)
      : previous &&
          previous.lat !== null &&
          previous.lng !== null &&
          previous.locationSource !== "default" &&
          previous.locationSource !== "manual"
        ? previous
        : undefined;
  const hasDetectedLocationResult = detectedLocation !== undefined;
  const coordinate = hasDetectedLocationResult
    ? detectedLocation ?? null
    : matched?.lat !== null &&
        matched?.lat !== undefined &&
        matched.lng !== null &&
        matched.lng !== undefined
      ? {
          place: matched.place,
          country: matched.country,
          lat: matched.lat,
          lng: matched.lng,
          source: "previous" as const,
        }
      : null;
  const capturedAt =
    Number.isFinite(fileLastModified) && fileLastModified > 0
      ? new Date(fileLastModified).toISOString()
      : new Date().toISOString();

  return {
    frames,
    segments: result.segments.map((segment) => ({
      ...segment,
      occurrenceId: nanoid(),
    })),
    initialPlace: hasDetectedLocationResult
      ? detectedLocation?.place || "?"
      : placeHint || fallbackPlace || previous?.place || "",
    initialPlaceSource: hasDetectedLocationResult
      ? detectedLocation?.source ?? "unavailable"
      : placeHint
        ? "voice"
        : fallbackPlace
          ? previous && normalizedPlace(fallbackPlace) === normalizedPlace(previous.place)
            ? "previous"
            : "manual"
          : previous
            ? "previous"
            : "manual",
    initialCountry: hasDetectedLocationResult
      ? detectedLocation?.country || "UNK"
      : matched?.country === "UNK"
        ? ""
        : matched?.country ?? "",
    coordinate,
    capturedAt,
    dateSource:
      Number.isFinite(fileLastModified) && fileLastModified > 0
        ? "fileModified"
        : "imported",
    truncated,
  };
}
