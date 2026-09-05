import { db } from "./db";

export type EncounterFileSource = "camera" | "album" | "insta360";

type PendingEncounterFile = {
  file: File;
  source: EncounterFileSource;
};

let pendingFile: PendingEncounterFile | null = null;

export async function setPendingEncounterFile(
  file: File,
  source: EncounterFileSource,
): Promise<void> {
  pendingFile = { file, source };
  try {
    await db.pendingEncounters.put({
      key: "current",
      file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      source,
    });
  } catch {
    // The in-memory copy still supports ordinary client-side navigation.
  }
}

export async function takePendingEncounterFile(): Promise<PendingEncounterFile | null> {
  const memoryCopy = pendingFile;
  pendingFile = null;
  if (memoryCopy) {
    void db.pendingEncounters.delete("current").catch(() => undefined);
    return memoryCopy;
  }
  try {
    const stored = await db.pendingEncounters.get("current");
    if (!stored) return null;
    await db.pendingEncounters.delete("current");
    return {
      file: new File([stored.file], stored.name, {
        type: stored.type,
        lastModified: stored.lastModified,
      }),
      source: stored.source,
    };
  } catch {
    return null;
  }
}
