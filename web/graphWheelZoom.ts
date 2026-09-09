const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

const LINE_HEIGHT_PX = 16;
const DEFAULT_PAGE_HEIGHT_PX = 800;
const MAX_WHEEL_DELTA_PX = 600;
const WHEEL_NOTCH_DELTA_PX = 100;
const WHEEL_NOTCH_ZOOM_FACTOR = 1.08;

export interface GraphWheelZoomInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  pageHeight?: number;
  ctrlKey?: boolean;
}

/**
 * Converts a vertical wheel gesture into a continuous zoom multiplier.
 * Returns null for gestures the graph should leave alone.
 */
export function getGraphWheelZoomFactor({
  deltaX,
  deltaY,
  deltaMode,
  pageHeight = DEFAULT_PAGE_HEIGHT_PX,
  ctrlKey = false
}: GraphWheelZoomInput): number | null {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || deltaY === 0) return null;

  const pixelsPerUnit = getPixelsPerWheelUnit(deltaMode, pageHeight);
  if (pixelsPerUnit === null) return null;

  const normalizedX = deltaX * pixelsPerUnit;
  const normalizedY = deltaY * pixelsPerUnit;
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return null;
  if (Math.abs(normalizedY) <= Math.abs(normalizedX)) return null;

  const clampedDelta = clamp(normalizedY, -MAX_WHEEL_DELTA_PX, MAX_WHEEL_DELTA_PX);
  // Trackpad pinch arrives as small Ctrl-wheel deltas in Chromium/Firefox.
  // Keep its gain separate from ordinary wheel scrolling.
  if (ctrlKey) return Math.exp(-clamp(normalizedY, -100, 100) * 0.01);
  const factor = Math.exp(
    (-clampedDelta / WHEEL_NOTCH_DELTA_PX) * Math.log(WHEEL_NOTCH_ZOOM_FACTOR)
  );
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

function getPixelsPerWheelUnit(deltaMode: number, pageHeight: number): number | null {
  if (deltaMode === DOM_DELTA_PIXEL) return 1;
  if (deltaMode === DOM_DELTA_LINE) return LINE_HEIGHT_PX;
  if (deltaMode !== DOM_DELTA_PAGE) return null;
  return Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
