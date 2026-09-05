let pendingFile: File | null = null;

export function setPendingEncounterFile(file: File): void {
  pendingFile = file;
}

export function takePendingEncounterFile(): File | null {
  const file = pendingFile;
  pendingFile = null;
  return file;
}
