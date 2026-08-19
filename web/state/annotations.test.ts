import assert from "node:assert/strict";
import test from "node:test";
import { annotationBounds, annotationLabelPoint, documentBounds, hitTestAnnotation, normalizeAnnotationDocument, resizeAnnotation, simplifyStroke, translateAnnotation } from "../annotations.ts";

test("normalizes a valid document and rejects unsafe data", () => {
  const document = normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "square", x: 1, y: 2, size: 10, name: " Box " }] });
  assert.equal(document.items[0].type, "square");
  assert.equal(document.items[0].type === "square" ? document.items[0].name : undefined, "Box");
  assert.throws(() => normalizeAnnotationDocument({ version: 2, items: [] }), /version/);
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "circle", cx: 0, cy: 0, radius: 0 }] }), /Degenerate/);
  assert.throws(() => normalizeAnnotationDocument({ version: 1, items: [{ id: "a", type: "line", x1: 0, y1: 0, x2: 2, y2: 2 }, { id: "a", type: "text", x: 0, y: 0, text: "x" }] }), /Duplicate/);
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

test("resizes line endpoints while preserving square and circle constraints", () => {
  assert.deepEqual(resizeAnnotation({ id: "l", type: "line", x1: 0, y1: 0, x2: 10, y2: 10 }, "start", { x: 3, y: 4 }), { id: "l", type: "line", x1: 3, y1: 4, x2: 10, y2: 10 });
  assert.deepEqual(resizeAnnotation({ id: "s", type: "square", x: 0, y: 0, size: 3 }, "size", { x: 8, y: 4 }), { id: "s", type: "square", x: 0, y: 0, size: 8 });
  assert.deepEqual(resizeAnnotation({ id: "c", type: "circle", cx: 0, cy: 0, radius: 3 }, "radius", { x: 3, y: 4 }), { id: "c", type: "circle", cx: 0, cy: 0, radius: 5 });
});
