import type { HistoryEntry, Item } from "./types";
import { historyEntrySchema } from "./schema";

export const MAX_HISTORY_ENTRIES = 200;

export function toHistoryEntry(item: Item): HistoryEntry {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    place: item.place,
    date: item.date,
    userNote: item.userNote.slice(0, 120),
  };
}

export function normalizeHistory(input: HistoryEntry[] | string): {
  entries: HistoryEntry[];
  truncated: boolean;
} {
  const entries =
    typeof input === "string"
      ? input
          .split(/\r?\n/)
          .map((line) => {
            const [id = "", name = "", category = "other", place = "", date = "", userNote = ""] =
              line.split("|").map((part) => part.trim());
            return { id, name, category, place, date, userNote };
          })
          .filter((entry) => entry.id && entry.name)
      : input;

  const parsed = entries.flatMap((entry) => {
    const result = historyEntrySchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });

  const sorted = [...parsed].sort((a, b) => a.date.localeCompare(b.date));
  return {
    entries: sorted.slice(-MAX_HISTORY_ENTRIES),
    truncated: sorted.length > MAX_HISTORY_ENTRIES,
  };
}

export function buildHistoryContext(items: Item[] | HistoryEntry[]): string {
  const { entries } = normalizeHistory(
    items.length > 0 && "createdAt" in items[0]
      ? (items as Item[]).map(toHistoryEntry)
      : (items as HistoryEntry[]),
  );

  return entries
    .map(
      (entry) =>
        `${entry.id} | ${entry.name} | ${entry.category} | ${entry.place} | ${entry.date.slice(0, 7)} | ${entry.userNote.slice(0, 30)}`,
    )
    .join("\n");
}

export function historyIds(input: HistoryEntry[] | string): Set<string> {
  return new Set(normalizeHistory(input).entries.map((entry) => entry.id));
}
