export interface NoteFileStatus {
  path?: string;
  signature?: string;
  modifiedMs?: number;
  byteLen?: number;
}

export interface SignatureDiff {
  pathsToRead: string[];
  deletedPaths: string[];
  nextSignatures: Map<string, string>;
}

export function fileSignature(file: NoteFileStatus | null | undefined): string {
  if (file && file.signature) return String(file.signature);
  const modified = Number(file && file.modifiedMs) || 0;
  const bytes = Number(file && file.byteLen) || 0;
  return `${modified}:${bytes}`;
}

export function buildFileSignatureMap(files: NoteFileStatus[] = []): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const file of files || []) {
    if (!file || !file.path) continue;
    signatures.set(file.path, fileSignature(file));
  }
  return signatures;
}

export function cloneFileSignatures(signatures: Map<string, string> | Record<string, string> | null | undefined): Map<string, string> {
  if (signatures instanceof Map) {
    return new Map(signatures);
  }
  if (signatures && typeof signatures === "object") {
    return new Map(Object.entries(signatures));
  }
  return new Map();
}

export function diffFileSignatures(
  currentSignatures: Map<string, string>,
  files: NoteFileStatus[] = []
): SignatureDiff {
  const nextSignatures = buildFileSignatureMap(files);
  const pathsToRead: string[] = [];
  const deletedPaths: string[] = [];

  for (const file of files || []) {
    if (!file || !file.path) continue;
    if (currentSignatures.get(file.path) === nextSignatures.get(file.path)) continue;
    pathsToRead.push(file.path);
  }

  for (const path of currentSignatures.keys()) {
    if (!nextSignatures.has(path)) {
      deletedPaths.push(path);
    }
  }

  return { pathsToRead, deletedPaths, nextSignatures };
}

export function liveUpdateStatus(added: number, changed: number, removed: number): string {
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} removed`);
  return `Live updated: ${parts.join(", ")}`;
}
