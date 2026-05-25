const DEFAULT_MARGIN = 12;
const DEFAULT_GAP = 10;

export function getClampedPopoverPosition(anchor, popoverSize, bounds, options = {}) {
  const margin = Number.isFinite(options.margin) ? options.margin : DEFAULT_MARGIN;
  const gap = Number.isFinite(options.gap) ? options.gap : DEFAULT_GAP;
  const width = Math.max(0, Number(popoverSize && popoverSize.width) || 0);
  const height = Math.max(0, Number(popoverSize && popoverSize.height) || 0);
  const leftBound = Number(bounds && bounds.left) || 0;
  const topBound = Number(bounds && bounds.top) || 0;
  const rightBound = Number(bounds && bounds.right) || leftBound;
  const bottomBound = Number(bounds && bounds.bottom) || topBound;
  const minLeft = leftBound + margin;
  const minTop = topBound + margin;
  const maxLeft = Math.max(minLeft, rightBound - margin - width);
  const maxTop = Math.max(minTop, bottomBound - margin - height);

  let left = (Number(anchor && anchor.x) || 0) + gap;
  if (left > maxLeft) {
    left = (Number(anchor && anchor.x) || 0) - gap - width;
  }

  let top = (Number(anchor && anchor.y) || 0) + gap;
  if (top > maxTop) {
    top = (Number(anchor && anchor.y) || 0) - gap - height;
  }

  return {
    left: Math.round(clamp(left, minLeft, maxLeft)),
    top: Math.round(clamp(top, minTop, maxTop)),
    maxWidth: Math.max(1, Math.round(rightBound - leftBound - margin * 2)),
    maxHeight: Math.max(1, Math.round(bottomBound - topBound - margin * 2))
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
