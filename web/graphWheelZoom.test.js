import assert from "node:assert/strict";
import test from "node:test";

import { getGraphWheelZoomFactor } from "./graphWheelZoom.ts";

test("rejects zero, horizontal, non-finite, and unsupported wheel gestures", () => {
  assert.equal(getGraphWheelZoomFactor({ deltaX: 0, deltaY: 0, deltaMode: 0 }), null);
  assert.equal(getGraphWheelZoomFactor({ deltaX: 20, deltaY: 10, deltaMode: 0 }), null);
  assert.equal(getGraphWheelZoomFactor({ deltaX: Number.NaN, deltaY: 10, deltaMode: 0 }), null);
  assert.equal(getGraphWheelZoomFactor({ deltaX: 0, deltaY: Number.POSITIVE_INFINITY, deltaMode: 0 }), null);
  assert.equal(getGraphWheelZoomFactor({ deltaX: 0, deltaY: 10, deltaMode: 3 }), null);
  assert.equal(getGraphWheelZoomFactor({ deltaX: 0, deltaY: 1, deltaMode: 2, pageHeight: 0 }), null);
});

test("normalizes pixel, line, and page deltas", () => {
  const pixelFactor = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 160, deltaMode: 0 });
  const lineFactor = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 10, deltaMode: 1 });
  const pageFactor = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 0.2, deltaMode: 2, pageHeight: 800 });

  assert.ok(pixelFactor);
  assert.equal(lineFactor, pixelFactor);
  assert.equal(pageFactor, pixelFactor);
});

test("uses continuous exponential zoom calibrated to the existing wheel notch", () => {
  const zoomIn = getGraphWheelZoomFactor({ deltaX: 0, deltaY: -100, deltaMode: 0 });
  const zoomOut = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 100, deltaMode: 0 });
  const smallZoomIn = getGraphWheelZoomFactor({ deltaX: 0, deltaY: -5, deltaMode: 0 });

  assert.ok(zoomIn);
  assert.ok(zoomOut);
  assert.ok(smallZoomIn);
  assert.ok(Math.abs(zoomIn - 1.08) < 1e-12);
  assert.ok(Math.abs(zoomOut - (1 / 1.08)) < 1e-12);
  assert.ok(smallZoomIn > 1 && smallZoomIn < zoomIn);
  assert.ok(Math.abs(zoomIn * zoomOut - 1) < 1e-12);
});

test("clamps pathological wheel deltas to finite symmetric factors", () => {
  const clampedIn = getGraphWheelZoomFactor({ deltaX: 0, deltaY: -600, deltaMode: 0 });
  const pathologicalIn = getGraphWheelZoomFactor({ deltaX: 0, deltaY: -1e100, deltaMode: 0 });
  const clampedOut = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 600, deltaMode: 0 });
  const pathologicalOut = getGraphWheelZoomFactor({ deltaX: 0, deltaY: 1e100, deltaMode: 0 });

  assert.equal(pathologicalIn, clampedIn);
  assert.equal(pathologicalOut, clampedOut);
  assert.ok(Number.isFinite(pathologicalIn));
  assert.ok(Number.isFinite(pathologicalOut));
  assert.ok(Math.abs(pathologicalIn * pathologicalOut - 1) < 1e-12);
});
