export type WorkspaceHistoryBudgetOptions<Entry = unknown> = {
  maxEntries?: number;
  maxBytes?: number;
  measureEntryBytes?: (entry: Entry) => number;
};

export type WorkspaceHistoryStacks<Entry = unknown> = {
  undoStack?: readonly Entry[];
  redoStack?: readonly Entry[];
};

const textEncoder = new TextEncoder();

export function measureWorkspaceHistoryEntryRawBytes(entry: unknown): number {
  return measureRawBytes(entry, new Set());
}

export function trimWorkspaceHistoryStack<Entry>(
  stack: readonly Entry[] = [],
  options: WorkspaceHistoryBudgetOptions<Entry> = {}
): Entry[] {
  const maxEntries = normalizeLimit(options.maxEntries, Infinity);
  if (maxEntries <= 0 || stack.length === 0) return [];

  const maxBytes = normalizeLimit(options.maxBytes, Infinity);
  const measureEntryBytes = options.measureEntryBytes || measureWorkspaceHistoryEntryRawBytes;
  const kept: Entry[] = [];
  let usedBytes = 0;

  for (let index = stack.length - 1; index >= 0 && kept.length < maxEntries; index -= 1) {
    const entry = stack[index];
    const entryBytes = normalizeMeasuredBytes(measureEntryBytes(entry));

    if (maxBytes === Infinity || usedBytes + entryBytes <= maxBytes || kept.length === 0) {
      kept.push(entry);
      usedBytes += entryBytes;
      continue;
    }

    break;
  }

  return kept.reverse();
}

export function trimWorkspaceHistoryStacks<Entry>(
  stacks: WorkspaceHistoryStacks<Entry>,
  options: WorkspaceHistoryBudgetOptions<Entry> = {}
): { undoStack: Entry[]; redoStack: Entry[] } {
  return {
    undoStack: trimWorkspaceHistoryStack(stacks.undoStack || [], options),
    redoStack: trimWorkspaceHistoryStack(stacks.redoStack || [], options)
  };
}

function measureRawBytes(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return textEncoder.encode(value).byteLength;
  if (typeof value === "number") return Number.isFinite(value) ? 8 : 0;
  if (typeof value === "boolean") return 4;
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return 0;

  if (seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.reduce((bytes, item) => bytes + measureRawBytes(item, seen), 0);
  }

  let bytes = 0;
  for (const [key, item] of Object.entries(value)) {
    bytes += textEncoder.encode(key).byteLength;
    bytes += measureRawBytes(item, seen);
  }
  return bytes;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeMeasuredBytes(value: number): number {
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}
