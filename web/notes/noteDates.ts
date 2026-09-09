export interface DateStamp {
  day: string | null;
  estimated: boolean;
}

export interface DateLine extends DateStamp {
  anchor: string;
}

export interface NoteDates {
  created: DateStamp;
  lines: DateLine[];
}

export interface DateDocument {
  version: 1;
  notes: Record<string, NoteDates>;
}

export interface SeedNoteDatesOptions {
  isNew?: boolean;
  day?: string | null;
  createdMs?: number | null;
  modifiedMs?: number | null;
}

export interface DateGroup {
  lineNumber: number;
  stamp: DateStamp;
}

const MAX_NOTES = 20_000;
const MAX_LINES_PER_NOTE = 100_000;
const MAX_TOTAL_LINES = 200_000;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MANUAL_DATE = /^\s*[*_]\s*(Written|Added)\s*:\s*(\d{4}-\d{2}-\d{2})\s*[*_]\s*$/i;
const HEADING = /^\s*#{1,6}(?:\s|$)/;

const unavailableStamp = (): DateStamp => ({ day: null, estimated: true });

export function localDay(date = new Date()): string | null {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayFromTimestamp(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return localDay(new Date(ms));
}

export function seedNoteDates(body: string, options: SeedNoteDatesOptions = {}): NoteDates {
  const lines = logicalLines(body);

  if (options.isNew) {
    const day = options.day === undefined ? localDay() : normalizeDay(options.day);
    const stamp: DateStamp = { day, estimated: false };
    return {
      created: { ...stamp },
      lines: lines.map((line) => ({ anchor: lineAnchor(line), ...stamp }))
    };
  }

  const createdDay = dayFromTimestamp(options.createdMs) ?? dayFromTimestamp(options.modifiedMs);
  const modifiedDay = dayFromTimestamp(options.modifiedMs);
  let created: DateStamp = createdDay ? { day: createdDay, estimated: true } : unavailableStamp();
  const baseline = modifiedDay ? { day: modifiedDay, estimated: true } : unavailableStamp();
  const datedLines: DateLine[] = lines.map((line) => ({ anchor: lineAnchor(line), ...baseline }));
  const markers = findManualMarkers(lines);

  const written = markers.find((marker) => marker.kind === "written");
  if (written) created = { day: written.day, estimated: false };

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const end = index + 1 < markers.length ? markers[index + 1].start : lines.length;
    for (let lineIndex = marker.start; lineIndex < end; lineIndex += 1) {
      datedLines[lineIndex] = {
        anchor: datedLines[lineIndex].anchor,
        day: marker.day,
        estimated: false
      };
    }
  }

  return { created, lines: datedLines };
}

export function reconcileNoteDates(body: string, previous: NoteDates | null | undefined, stamp: DateStamp): NoteDates {
  const lines = logicalLines(body);
  const anchors = lines.map(lineAnchor);
  const nextStamp = normalizeStamp(stamp);
  const prior = normalizeNoteDates(previous);

  if (!prior) {
    return {
      created: { ...nextStamp },
      lines: anchors.map((anchor) => ({ anchor, ...nextStamp }))
    };
  }

  const result = anchors.map((anchor) => ({ anchor, ...nextStamp }));
  const oldAnchors = prior.lines.map((line) => line.anchor);
  let prefix = 0;
  const sharedLength = Math.min(anchors.length, oldAnchors.length);
  while (prefix < sharedLength && anchors[prefix] === oldAnchors[prefix]) {
    result[prefix] = { ...prior.lines[prefix] };
    prefix += 1;
  }

  let oldEnd = oldAnchors.length - 1;
  let newEnd = anchors.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldAnchors[oldEnd] === anchors[newEnd]) {
    result[newEnd] = { ...prior.lines[oldEnd] };
    oldEnd -= 1;
    newEnd -= 1;
  }

  // Interior lines are retained only when their content occurs exactly once on
  // both sides and those matches remain ordered. Ambiguous duplicates receive
  // the edit stamp instead of inheriting provenance from an arbitrary copy.
  const oldCandidates = uniquePositions(oldAnchors, 0, oldAnchors.length - 1);
  const newCandidates = uniquePositions(anchors, 0, anchors.length - 1);
  let lastOldIndex = prefix - 1;
  for (let newIndex = prefix; newIndex <= newEnd; newIndex += 1) {
    const anchor = anchors[newIndex];
    const oldIndex = oldCandidates.get(anchor);
    if (oldIndex === undefined || newCandidates.get(anchor) !== newIndex || oldIndex <= lastOldIndex) continue;
    result[newIndex] = { ...prior.lines[oldIndex] };
    lastOldIndex = oldIndex;
  }

  return { created: { ...prior.created }, lines: result };
}

export function dateGroups(body: string, dates: NoteDates | null | undefined): DateGroup[] {
  const lines = logicalLines(body);
  const normalized = normalizeNoteDates(dates);
  const groups: DateGroup[] = [];
  let active: { stamp: DateStamp; lineNumber: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const line = normalized?.lines[index];
    const stamp = line ? normalizeStamp(line) : unavailableStamp();
    if (active && active.stamp.day === stamp.day) {
      active.lineNumber = index + 1;
      active.stamp.estimated ||= stamp.estimated;
      continue;
    }
    if (active) groups.push(active);
    active = { stamp, lineNumber: index + 1 };
  }

  if (active) groups.push(active);
  return groups;
}

export function formatDateStamp(stamp: DateStamp): string {
  const normalized = normalizeStamp(stamp);
  if (!normalized.day) return "Date unavailable";
  const [year, month, day] = normalized.day.split("-").map(Number);
  const formatted = `${day} ${MONTHS[month - 1]} ${year}`;
  return normalized.estimated ? `≈ ${formatted}` : formatted;
}

export function emptyDateDocument(): DateDocument {
  return { version: 1, notes: {} };
}

export function normalizeDateDocument(value: unknown): DateDocument {
  if (!isRecord(value)) throw new Error("Date metadata must be an object.");
  assertExactKeys(value, ["version", "notes"], "date document");
  if (value.version !== 1) throw new Error("Unsupported date metadata version.");
  if (!isRecord(value.notes)) throw new Error("Date metadata notes must be an object.");

  const notes: Record<string, NoteDates> = {};
  let noteCount = 0;
  let totalLines = 0;
  for (const [path, rawNote] of Object.entries(value.notes)) {
    noteCount += 1;
    if (noteCount > MAX_NOTES) throw new Error(`Date metadata exceeds ${MAX_NOTES} notes.`);
    if (!isRelativeMarkdownPath(path)) throw new Error(`Invalid date metadata note path: ${path}`);
    const note = strictNoteDates(rawNote, path);
    totalLines += note.lines.length;
    if (totalLines > MAX_TOTAL_LINES) throw new Error(`Date metadata exceeds ${MAX_TOTAL_LINES} total lines.`);
    notes[path] = note;
  }
  const document: DateDocument = { version: 1, notes };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Date metadata exceeds 16 MiB.");
  }
  return document;
}

export function lineAnchor(text: string): string {
  const value = String(text);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < seeds.length; hashIndex += 1) {
      seeds[hashIndex] ^= code + Math.imul(index + 1, hashIndex + 1);
      seeds[hashIndex] = Math.imul(seeds[hashIndex], 0x01000193 + hashIndex * 2) >>> 0;
      seeds[hashIndex] = (seeds[hashIndex] ^ (seeds[hashIndex] >>> 13)) >>> 0;
    }
  }
  return seeds.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function logicalLines(body: string): string[] {
  let lineCount = 1;
  for (let index = 0; index < body.length; index += 1) {
    if (body.charCodeAt(index) === 10) lineCount += 1;
    if (lineCount > MAX_LINES_PER_NOTE) throw new Error(`Note exceeds ${MAX_LINES_PER_NOTE} date lines.`);
  }
  return String(body).split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function normalizeDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? value : null;
}

function normalizeStamp(value: unknown): DateStamp {
  if (!isRecord(value)) return unavailableStamp();
  const day = value.day === null ? null : normalizeDay(value.day);
  return {
    day,
    estimated: typeof value.estimated === "boolean" ? value.estimated : true
  };
}

function normalizeNoteDates(value: unknown): NoteDates | null {
  if (!isRecord(value) || !Array.isArray(value.lines) || value.lines.length > MAX_LINES_PER_NOTE) return null;
  const lines: DateLine[] = [];
  for (const rawLine of value.lines) {
    if (!isRecord(rawLine) || typeof rawLine.anchor !== "string" || !/^[0-9a-f]{32}$/.test(rawLine.anchor)) return null;
    lines.push({ anchor: rawLine.anchor, ...normalizeStamp(rawLine) });
  }
  return { created: normalizeStamp(value.created), lines };
}

function strictNoteDates(value: unknown, path: string): NoteDates {
  if (!isRecord(value)) throw new Error(`Date metadata for ${path} must be an object.`);
  assertExactKeys(value, ["created", "lines"], `date metadata for ${path}`);
  if (!Array.isArray(value.lines)) throw new Error(`Date metadata lines for ${path} must be an array.`);
  if (value.lines.length > MAX_LINES_PER_NOTE) {
    throw new Error(`Date metadata for ${path} exceeds ${MAX_LINES_PER_NOTE} lines.`);
  }
  return {
    created: strictDateStamp(value.created, `created date for ${path}`),
    lines: value.lines.map((line, index) => strictDateLine(line, `${path} line ${index + 1}`))
  };
}

function strictDateStamp(value: unknown, label: string): DateStamp {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["day", "estimated"], label);
  if (value.day !== null && normalizeDay(value.day) === null) throw new Error(`${label} has an invalid day.`);
  if (typeof value.estimated !== "boolean") throw new Error(`${label} must declare estimated.`);
  return { day: value.day as string | null, estimated: value.estimated };
}

function strictDateLine(value: unknown, label: string): DateLine {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["anchor", "day", "estimated"], label);
  if (typeof value.anchor !== "string" || !/^[0-9a-f]{32}$/.test(value.anchor)) {
    throw new Error(`${label} has an invalid anchor.`);
  }
  const stamp = strictDateStamp({ day: value.day, estimated: value.estimated }, label);
  return { anchor: value.anchor, ...stamp };
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
}

function isRelativeMarkdownPath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return /\.md$/i.test(parts.at(-1) ?? "");
}

function findManualMarkers(lines: string[]): Array<{ kind: "written" | "added"; day: string; start: number }> {
  const markers: Array<{ kind: "written" | "added"; day: string; start: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(MANUAL_DATE);
    const day = match ? normalizeDay(match[2]) : null;
    if (!match || !day) continue;
    let start = index;
    let previous = index - 1;
    while (previous >= 0 && !lines[previous].trim()) previous -= 1;
    if (previous >= 0 && HEADING.test(lines[previous])) start = previous;
    markers.push({ kind: match[1].toLowerCase() as "written" | "added", day, start });
  }
  return markers;
}

function uniquePositions(values: string[], start: number, end: number): Map<string, number> {
  const positions = new Map<string, number>();
  const duplicates = new Set<string>();
  for (let index = start; index <= end; index += 1) {
    const value = values[index];
    if (positions.has(value)) duplicates.add(value);
    else positions.set(value, index);
  }
  for (const duplicate of duplicates) positions.delete(duplicate);
  return positions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
