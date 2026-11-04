import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAX_ANNOTATION_DOCUMENT_BYTES, MAX_ANNOTATION_NAME_LENGTH, MAX_ANNOTATION_TEXT_LENGTH, annotationBounds, annotationLabelPoint, documentBounds, hitTestAnnotation, normalizeAnnotationDocument, resizeAnnotation, simplifyStroke, translateAnnotation } from "../annotations.ts";

const parityFixtures = JSON.parse(readFileSync(new URL("../../tests/fixtures/annotations-parity.json", import.meta.url), "utf8"));

test("downloadable agent skill examples produce valid canvas annotations", () => {
  const skill = readFileSync(new URL("../../skills/apex-notes-writing/SKILL.md", import.meta.url), "utf8");
  const examples = [...skill.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  assert.ok(examples.length > 0, "Agents need a usable annotation document example");
  for (const [, source] of examples) {
    const document = normalizeAnnotationDocument(JSON.parse(source));
    assert.ok(document.items.length > 0);
    assert.ok(documentBounds(document), "Example shapes must be fittable on the canvas");
  }
});

test("normalizes a valid document and rejects unsafe data", () => {
  const document = normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "square", x: 1, y: 2, size: 10, name: " Box " }] });
  assert.equal(document.items[0].type, "square");
  assert.equal(document.items[0].type === "square" ? document.items[0].name : undefined, " Box ");
  assert.throws(() => normalizeAnnotationDocument({ version: 2, items: [] }), /version/);
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "circle", cx: 0, cy: 0, radius: 0 }] }), /Degenerate/);
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "line", x1: 0, y1: 0, x2: 2, y2: 2 }, { id: "a", type: "text", x: 0, y: 0, text: "x" }] }), /Duplicate/);
});

test("matches native parity fixtures and preserves external strings byte-for-byte", () => {
  const normalized = normalizeAnnotationDocument(parityFixtures.valid);
  assert.equal(normalized.items[0].id, "  line-😀  ");
  assert.equal(normalized.items[0].type === "line" ? normalized.items[0].name : "", "  external 😀 name  ");
  for (const invalid of parityFixtures.invalid) assert.throws(() => normalizeAnnotationDocument(invalid));
});

test("counts Unicode code points and enforces a total serialized document budget", () => {
  const exactUnicodeName = "😀".repeat(MAX_ANNOTATION_NAME_LENGTH);
  assert.doesNotThrow(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "emoji", type: "circle", cx: 0, cy: 0, radius: 1, name: exactUnicodeName }] }));
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "emoji", type: "circle", cx: 0, cy: 0, radius: 1, name: `${exactUnicodeName}😀` }] }), /name/);
  const hugeId = "i".repeat(MAX_ANNOTATION_DOCUMENT_BYTES);
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: hugeId, type: "text", x: 0, y: 0, text: "" }] }), /too large/);
  const tooMuchText = Array.from({ length: 11 }, (_, index) => ({ id: `text-${index}`, type: "text", x: index, y: 0, text: "t".repeat(MAX_ANNOTATION_TEXT_LENGTH) }));
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: tooMuchText }), /Too much/);
});

test("computes geometry, labels and hit targets", () => {
  const square = { id: "s", type: "square" as const, x: 10, y: 20, size: 30, name: "box" };
  assert.deepEqual(annotationBounds(square), { minX: 10, minY: 20, maxX: 40, maxY: 50, width: 30, height: 30 });
  assert.deepEqual(annotationLabelPoint(square), { x: 25, y: 12 });
  assert.equal(hitTestAnnotation(square, { x: 10, y: 30 }), true);
  assert.equal(hitTestAnnotation({ id: "l", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 }, { x: 50, y: 4 }, 5), true);
  assert.deepEqual(translateAnnotation(square, 5, -5), { ...square, x: 15, y: 15 });
  assert.deepEqual(documentBounds({ version: 1, items: [square] }), annotationBounds(square));
});

test("simplifies sampled freehand points and preserves endpoints", () => {
  const result = simplifyStroke([{ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { x: 5, y: 0 }, { x: 10, y: 0 }], 1);
  assert.deepEqual(result, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
});

test("resizes line endpoints and legacy squares into independently sized rectangles", () => {
  assert.deepEqual(resizeAnnotation({ id: "l", type: "line", x1: 0, y1: 0, x2: 10, y2: 10 }, "start", { x: 3, y: 4 }), { id: "l", type: "line", x1: 3, y1: 4, x2: 10, y2: 10 });
  assert.deepEqual(resizeAnnotation({ id: "s", type: "square", x: 0, y: 0, size: 3, name: "Old square" }, "size", { x: 8, y: 4 }), { id: "s", type: "rectangle", x: 0, y: 0, width: 8, height: 4, name: "Old square" });
  assert.deepEqual(resizeAnnotation({ id: "c", type: "circle", cx: 0, cy: 0, radius: 3 }, "radius", { x: 3, y: 4 }), { id: "c", type: "circle", cx: 0, cy: 0, radius: 5 });
});

test("rectangles retain independent dimensions through validation, geometry and movement", () => {
  const rectangle = { id: "r", type: "rectangle" as const, x: -20, y: 30, width: 90, height: 25, name: "Wide area" };
  const normalized = normalizeAnnotationDocument({ version: 1, items: [rectangle] });
  assert.deepEqual(normalized.items, [rectangle]);
  assert.deepEqual(annotationBounds(rectangle), { minX: -20, minY: 30, maxX: 70, maxY: 55, width: 90, height: 25 });
  assert.deepEqual(annotationLabelPoint(rectangle), { x: 25, y: 22 });
  assert.deepEqual(translateAnnotation(rectangle, 5, -10), { ...rectangle, x: -15, y: 20 });
  assert.equal(hitTestAnnotation(rectangle, { x: 68, y: 40 }), true);
  assert.equal(hitTestAnnotation(rectangle, { x: 68, y: 70 }), false);
  for (const dimensions of [{ width: 0 }, { height: -1 }, { width: Infinity }, { height: NaN }, { width: "90" }, { height: null }, { size: 90 }]) {
    assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ ...rectangle, ...dimensions }] }));
  }
  const original = { id: "legacy", type: "square" as const, x: 4, y: 8, size: 12 };
  assert.deepEqual(normalizeAnnotationDocument({ version: 1, items: [original] }).items, [original]);
});

test("rectangle resizing crosses the anchor independently in every quadrant", () => {
  const rectangle = { id: "r", type: "rectangle" as const, x: 10, y: 20, width: 30, height: 40 };
  for (const [point, expected] of [
    [{ x: 80, y: 35 }, { x: 10, y: 20, width: 70, height: 15 }],
    [{ x: -30, y: 35 }, { x: -30, y: 20, width: 40, height: 15 }],
    [{ x: 80, y: -5 }, { x: 10, y: -5, width: 70, height: 25 }],
    [{ x: -30, y: -5 }, { x: -30, y: -5, width: 40, height: 25 }],
    [{ x: 10, y: 20 }, { x: 10, y: 20, width: 1, height: 1 }]
  ]) {
    assert.deepEqual(resizeAnnotation(rectangle, "size", point), { id: "r", type: "rectangle", ...expected });
  }
});
