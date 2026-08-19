export const ANNOTATION_VERSION = 1 as const;
export const MAX_ANNOTATION_ITEMS = 5_000;
export const MAX_STROKE_POINTS = 4_096;
export const MAX_TOTAL_STROKE_POINTS = 100_000;
export const MAX_ANNOTATION_NAME_LENGTH = 120;
export const MAX_ANNOTATION_TEXT_LENGTH = 20_000;
export const MAX_TOTAL_ANNOTATION_TEXT_LENGTH = 200_000;
export const MAX_ANNOTATION_DOCUMENT_BYTES = 4 * 1024 * 1024;

export type Point = { x: number; y: number };
export type LineAnnotation = { id: string; type: "line"; x1: number; y1: number; x2: number; y2: number; name?: string };
export type SquareAnnotation = { id: string; type: "square"; x: number; y: number; size: number; name?: string };
export type CircleAnnotation = { id: string; type: "circle"; cx: number; cy: number; radius: number; name?: string };
export type StrokeAnnotation = { id: string; type: "stroke"; points: Point[] };
export type TextAnnotation = { id: string; type: "text"; x: number; y: number; text: string };
export type Annotation = LineAnnotation | SquareAnnotation | CircleAnnotation | StrokeAnnotation | TextAnnotation;
export type AnnotationDocument = { version: 1; items: Annotation[] };
export type AnnotationTool = "select" | "pen" | "line" | "square" | "circle" | "text";

export const emptyAnnotationDocument = (): AnnotationDocument => ({ version: ANNOTATION_VERSION, items: [] });

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonEmptyId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const codePointLength = (value: string) => [...value].length;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const allowedKeysByType = {
  line: new Set(["id", "type", "x1", "y1", "x2", "y2", "name"]),
  square: new Set(["id", "type", "x", "y", "size", "name"]),
  circle: new Set(["id", "type", "cx", "cy", "radius", "name"]),
  stroke: new Set(["id", "type", "points"]),
  text: new Set(["id", "type", "x", "y", "text"])
} as const;

export function normalizeAnnotationDocument(value: unknown): AnnotationDocument {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== ANNOTATION_VERSION) {
    throw new Error("Unsupported annotations document version");
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "items")) throw new Error("Unknown annotations document field");
  const rawItems = (value as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) throw new Error("Annotations items must be an array");
  if (rawItems.length > MAX_ANNOTATION_ITEMS) throw new Error("Too many annotations");
  const serialized = JSON.stringify(value) || "";
  if (utf8Bytes(serialized) > MAX_ANNOTATION_DOCUMENT_BYTES) throw new Error("Annotations document is too large");
  const ids = new Set<string>();
  let totalPoints = 0;
  let totalText = 0;
  const items = rawItems.map((raw, index) => {
    const item = normalizeAnnotation(raw, index);
    if (ids.has(item.id)) throw new Error(`Duplicate annotation id: ${item.id}`);
    ids.add(item.id);
    if (item.type === "stroke") {
      totalPoints += item.points.length;
      if (totalPoints > MAX_TOTAL_STROKE_POINTS) throw new Error("Too many annotation points");
    }
    if ("name" in item && typeof item.name === "string") totalText += codePointLength(item.name);
    if (item.type === "text") totalText += codePointLength(item.text);
    if (totalText > MAX_TOTAL_ANNOTATION_TEXT_LENGTH) throw new Error("Too much annotation text");
    return item;
  });
  return { version: ANNOTATION_VERSION, items };
}

function normalizeAnnotation(raw: unknown, index: number): Annotation {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid annotation at index ${index}`);
  const item = raw as Record<string, unknown>;
  if (!nonEmptyId(item.id)) throw new Error(`Invalid annotation id at index ${index}`);
  const id = item.id;
  if (typeof item.type !== "string" || !(item.type in allowedKeysByType)) throw new Error(`Unknown annotation type at index ${index}`);
  const allowedKeys = allowedKeysByType[item.type as keyof typeof allowedKeysByType];
  if (Object.keys(item).some((key) => !allowedKeys.has(key))) throw new Error(`Unknown annotation field at index ${index}`);
  const name = normalizeName(item.name);
  if (item.type === "line") {
    requireFinite(item, ["x1", "y1", "x2", "y2"], index);
    if (item.x1 === item.x2 && item.y1 === item.y2) {
      throw new Error(`Degenerate line at index ${index}`);
    }
    return withName({ id, type: "line", x1: item.x1 as number, y1: item.y1 as number, x2: item.x2 as number, y2: item.y2 as number }, name);
  }
  if (item.type === "square") {
    requireFinite(item, ["x", "y", "size"], index);
    if ((item.size as number) <= 0) throw new Error(`Degenerate square at index ${index}`);
    return withName({ id, type: "square", x: item.x as number, y: item.y as number, size: item.size as number }, name);
  }
  if (item.type === "circle") {
    requireFinite(item, ["cx", "cy", "radius"], index);
    if ((item.radius as number) <= 0) throw new Error(`Degenerate circle at index ${index}`);
    return withName({ id, type: "circle", cx: item.cx as number, cy: item.cy as number, radius: item.radius as number }, name);
  }
  if (item.type === "stroke") {
    if (!Array.isArray(item.points) || item.points.length < 2 || item.points.length > MAX_STROKE_POINTS) {
      throw new Error(`Invalid stroke points at index ${index}`);
    }
    const points = item.points.map((point, pointIndex) => {
      if (!point || typeof point !== "object" || !finite((point as Point).x) || !finite((point as Point).y)) {
        throw new Error(`Invalid stroke point ${pointIndex} at index ${index}`);
      }
      if (Object.keys(point as object).some((key) => key !== "x" && key !== "y")) throw new Error(`Unknown stroke point field at index ${index}`);
      return { x: (point as Point).x, y: (point as Point).y };
    });
    if (points.slice(1).every((point) => point.x === points[0].x && point.y === points[0].y)) throw new Error(`Degenerate stroke at index ${index}`);
    return { id, type: "stroke", points };
  }
  if (item.type === "text") {
    requireFinite(item, ["x", "y"], index);
    if (typeof item.text !== "string" || codePointLength(item.text) > MAX_ANNOTATION_TEXT_LENGTH) throw new Error(`Invalid annotation text at index ${index}`);
    return { id, type: "text", x: item.x as number, y: item.y as number, text: item.text };
  }
  throw new Error(`Unknown annotation type at index ${index}`);
}

function requireFinite(item: Record<string, unknown>, keys: string[], index: number) {
  if (keys.some((key) => !finite(item[key]))) throw new Error(`Non-finite annotation geometry at index ${index}`);
}

function normalizeName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || codePointLength(value) > MAX_ANNOTATION_NAME_LENGTH) throw new Error("Invalid annotation name");
  return value;
}

function withName<T extends Annotation>(item: T, name?: string): T {
  return (name === undefined ? item : { ...item, name }) as T;
}

export function cloneAnnotationDocument(document: AnnotationDocument): AnnotationDocument {
  return structuredClone(document);
}

export function annotationBounds(item: Annotation) {
  if (item.type === "line") return bounds(item.x1, item.y1, item.x2, item.y2);
  if (item.type === "square") return { minX: item.x, minY: item.y, maxX: item.x + item.size, maxY: item.y + item.size, width: item.size, height: item.size };
  if (item.type === "circle") return { minX: item.cx - item.radius, minY: item.cy - item.radius, maxX: item.cx + item.radius, maxY: item.cy + item.radius, width: item.radius * 2, height: item.radius * 2 };
  if (item.type === "text") return { minX: item.x, minY: item.y - 18, maxX: item.x + Math.max(24, longestLine(item.text) * 8), maxY: item.y + Math.max(18, item.text.split("\n").length * 18), width: Math.max(24, longestLine(item.text) * 8), height: Math.max(36, item.text.split("\n").length * 18) };
  const xs = item.points.map((point) => point.x);
  const ys = item.points.map((point) => point.y);
  return bounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function bounds(x1: number, y1: number, x2: number, y2: number) {
  const minX = Math.min(x1, x2), minY = Math.min(y1, y2), maxX = Math.max(x1, x2), maxY = Math.max(y1, y2);
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

const longestLine = (text: string) => Math.max(0, ...text.split("\n").map((line) => line.length));

export function documentBounds(document: AnnotationDocument) {
  if (!document.items.length) return null;
  const all = document.items.map(annotationBounds);
  const minX = Math.min(...all.map((item) => item.minX));
  const minY = Math.min(...all.map((item) => item.minY));
  const maxX = Math.max(...all.map((item) => item.maxX));
  const maxY = Math.max(...all.map((item) => item.maxY));
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function translateAnnotation(item: Annotation, dx: number, dy: number): Annotation {
  if (item.type === "line") return { ...item, x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy };
  if (item.type === "square") return { ...item, x: item.x + dx, y: item.y + dy };
  if (item.type === "circle") return { ...item, cx: item.cx + dx, cy: item.cy + dy };
  if (item.type === "text") return { ...item, x: item.x + dx, y: item.y + dy };
  return { ...item, points: item.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
}

export function resizeAnnotation(item: Annotation, handle: string, point: Point): Annotation {
  if (item.type === "line") return handle === "start" ? { ...item, x1: point.x, y1: point.y } : { ...item, x2: point.x, y2: point.y };
  if (item.type === "square") return { ...item, size: Math.max(1, Math.max(Math.abs(point.x - item.x), Math.abs(point.y - item.y))) };
  if (item.type === "circle") return { ...item, radius: Math.max(1, Math.hypot(point.x - item.cx, point.y - item.cy)) };
  return item;
}

export function simplifyStroke(points: Point[], tolerance = 1.5): Point[] {
  if (points.length <= 2) return points.slice();
  const sqTolerance = tolerance * tolerance;
  const radial: Point[] = [points[0]];
  let previous = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (distanceSq(point, previous) > sqTolerance) {
      radial.push(point);
      previous = point;
    }
  }
  if (previous !== points[points.length - 1]) radial.push(points[points.length - 1]);
  return radial.slice(0, MAX_STROKE_POINTS);
}

const distanceSq = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function hitTestAnnotation(item: Annotation, point: Point, tolerance = 8): boolean {
  if (item.type === "line") return distanceToSegment(point, { x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 }) <= tolerance;
  if (item.type === "stroke") return item.points.some((current, index) => index > 0 && distanceToSegment(point, item.points[index - 1], current) <= tolerance);
  if (item.type === "circle") return Math.abs(Math.hypot(point.x - item.cx, point.y - item.cy) - item.radius) <= tolerance;
  const itemBounds = annotationBounds(item);
  return point.x >= itemBounds.minX - tolerance && point.x <= itemBounds.maxX + tolerance && point.y >= itemBounds.minY - tolerance && point.y <= itemBounds.maxY + tolerance;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const lengthSq = distanceSq(start, end);
  if (!lengthSq) return Math.sqrt(distanceSq(point, start));
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSq));
  return Math.hypot(point.x - (start.x + t * (end.x - start.x)), point.y - (start.y + t * (end.y - start.y)));
}

export function annotationLabelPoint(item: LineAnnotation | SquareAnnotation | CircleAnnotation) {
  if (item.type === "line") return { x: (item.x1 + item.x2) / 2, y: (item.y1 + item.y2) / 2 - 8 };
  if (item.type === "square") return { x: item.x + item.size / 2, y: item.y - 8 };
  return { x: item.cx, y: item.cy - item.radius - 8 };
}

export function createAnnotationId(cryptoRef: Pick<Crypto, "randomUUID"> | undefined = globalThis.crypto) {
  return cryptoRef?.randomUUID ? cryptoRef.randomUUID() : `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
