import { buildMapPins } from "./map-pins";
import type { MemoryGlobeApiPin, MemoryGlobePin } from "../components/MemoryGlobe";
import type { Item } from "./types";

export function hydrateMapPins(pins: MemoryGlobeApiPin[], items: Item[]): MemoryGlobePin[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  return pins.map((pin) => ({
    ...pin,
    coverPhoto: itemById.get(pin.coverItemId)?.photo ?? "",
    preview: pin.preview.map((preview) => ({
      ...preview,
      photo: itemById.get(preview.id)?.photo ?? "",
    })),
    locations: pin.locations.map((location) => ({
      ...location,
      coverPhoto: itemById.get(location.coverItemId)?.photo ?? "",
      preview: location.itemIds.slice(0, 3).flatMap((id) => {
        const item = itemById.get(id);
        if (!item) return [];
        return [{
          id: item.id,
          name: item.name,
          date: item.date,
          note: item.userNote,
          mediaKind: item.mediaKind ?? "standard",
          photo: item.photo,
        }];
      }),
    })),
  }));
}

export function localMapPins(items: Item[]) {
  return hydrateMapPins(
    buildMapPins({ items, coordinatePrecision: 3 }) as MemoryGlobeApiPin[],
    items,
  );
}
