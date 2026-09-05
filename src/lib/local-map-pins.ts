import { buildMapPins } from "./map-pins";
import type { Item } from "./types";

export function localMapPins(items: Item[]) {
  const photos = new Map(items.map((item) => [item.id, item.photo]));
  return buildMapPins({ items, coordinatePrecision: 3 }).map((pin) => ({
    ...pin,
    coverPhoto: photos.get(pin.coverItemId) ?? "",
    locations: pin.locations.map((location) => ({
      ...location,
      coverPhoto: photos.get(location.coverItemId) ?? "",
    })),
  }));
}
