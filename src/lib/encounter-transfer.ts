export type EncounterFileSource = "camera" | "album" | "insta360";

type PendingEncounterFile = {
  file: File;
  source: EncounterFileSource;
};

let pendingFile: PendingEncounterFile | null = null;

export function setPendingEncounterFile(file: File, source: EncounterFileSource): void {
  pendingFile = { file, source };
}

export function takePendingEncounterFile(): PendingEncounterFile | null {
  const file = pendingFile;
  pendingFile = null;
  return file;
}
