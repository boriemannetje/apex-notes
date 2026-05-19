const DEFAULT_OPTIONS = Object.freeze({
  levelGap: 138,
  nodeGap: 168,
  collisionGap: 168,
  looseGapX: 168,
  looseGapY: 138,
  looseMarginX: 336,
  looseColumns: 0,
  precision: 3
});

export function resolveStoredPosition(path, stored, autoPositions, options = {}) {
  if (!stored || typeof stored !== "object") return null;
  const settings = normalizeOptions(options);
  const autoPosition = getPosition(autoPositions, path);
  const dx = toFiniteNumber(stored.dx);
  const dy = toFiniteNumber(stored.dy);

  if (Number.isFinite(dx) || Number.isFinite(dy)) {
    if (!autoPosition) return null;
    return roundPosition(
      {
        x: autoPosition.x + (Number.isFinite(dx) ? dx : 0),
        y: autoPosition.y + (Number.isFinite(dy) ? dy : 0)
      },
      settings.precision
    );
  }

  const x = toFiniteNumber(stored.x);
  const y = toFiniteNumber(stored.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return roundPosition({ x, y }, settings.precision);
}

export function resolveStoredPositions(storedPositions, autoPositions, options = {}) {
  const resolved = {};
  for (const [path, stored] of positionEntries(storedPositions)) {
    const position = resolveStoredPosition(path, stored, autoPositions, options);
    if (position) resolved[path] = position;
  }
  return resolved;
}

export function createAbsolutePositionPatch(paths, currentPositions, options = {}) {
  const settings = normalizeOptions(options);
  const patch = {};

  for (const path of paths || []) {
    const position = getPosition(currentPositions, path);
    if (!position) continue;
    patch[path] = roundPosition(position, settings.precision);
  }

  return patch;
}

export function findChildPosition(parentPath, currentPositions, options = {}) {
  const settings = normalizeOptions(options);
  const parent = getPosition(currentPositions, parentPath);
  if (!parent) return null;

  const occupied = collectPositions(currentPositions);
  const base = {
    x: parent.x,
    y: parent.y + settings.levelGap
  };

  return findOpenPosition(base, occupied, {
    stepX: settings.collisionGap,
    stepY: settings.levelGap,
    gapX: settings.collisionGap,
    gapY: Math.min(settings.levelGap, settings.collisionGap),
    precision: settings.precision
  });
}

export function findLooseGridPositions(paths, currentPositions, options = {}) {
  const settings = normalizeOptions(options);
  const items = Array.from(paths || []).filter(Boolean);
  const patch = {};
  if (!items.length) return patch;

  const existing = collectPositions(currentPositions);
  const bounds = getBounds(existing);
  const columns = settings.looseColumns || Math.max(1, Math.ceil(Math.sqrt(items.length)));
  const startX = bounds ? bounds.maxX + settings.looseMarginX : 0;
  const startY = bounds ? bounds.minY : 0;

  items.forEach((path, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    patch[path] = roundPosition(
      {
        x: startX + column * settings.looseGapX,
        y: startY + row * settings.looseGapY
      },
      settings.precision
    );
  });

  return patch;
}

function findOpenPosition(base, occupied, options) {
  const limit = Math.max(occupied.length + 2, 8);

  for (let row = 0; row <= limit; row += 1) {
    const y = base.y + row * options.stepY;
    for (const offset of alternatingOffsets(limit)) {
      const candidate = roundPosition(
        {
          x: base.x + offset * options.stepX,
          y
        },
        options.precision
      );
      if (!hasCollision(candidate, occupied, options)) return candidate;
    }
  }

  return roundPosition(
    {
      x: base.x,
      y: base.y + (limit + 1) * options.stepY
    },
    options.precision
  );
}

function alternatingOffsets(limit) {
  const offsets = [0];
  for (let index = 1; index <= limit; index += 1) {
    offsets.push(index, -index);
  }
  return offsets;
}

function hasCollision(candidate, positions, options) {
  return positions.some(
    (position) =>
      Math.abs(position.x - candidate.x) < options.gapX &&
      Math.abs(position.y - candidate.y) < options.gapY
  );
}

function collectPositions(positions) {
  return positionEntries(positions)
    .map(([, position]) => normalizePosition(position))
    .filter(Boolean);
}

function getPosition(positions, path) {
  if (!path || !positions) return null;
  if (positions instanceof Map) return normalizePosition(positions.get(path));
  return normalizePosition(positions[path]);
}

function positionEntries(positions) {
  if (!positions) return [];
  if (positions instanceof Map) return [...positions.entries()];
  if (typeof positions === "object") return Object.entries(positions);
  return [];
}

function normalizePosition(position) {
  if (!position || typeof position !== "object") return null;
  const x = toFiniteNumber(position.x);
  const y = toFiniteNumber(position.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function getBounds(positions) {
  if (!positions.length) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const position of positions) {
    minX = Math.min(minX, position.x);
    maxX = Math.max(maxX, position.x);
    minY = Math.min(minY, position.y);
    maxY = Math.max(maxY, position.y);
  }

  return { minX, maxX, minY, maxY };
}

function normalizeOptions(options) {
  const nodeGap = positiveNumber(options.nodeGap, DEFAULT_OPTIONS.nodeGap);

  return {
    levelGap: positiveNumber(options.levelGap, DEFAULT_OPTIONS.levelGap),
    nodeGap,
    collisionGap: positiveNumber(options.collisionGap, nodeGap),
    looseGapX: positiveNumber(options.looseGapX, nodeGap),
    looseGapY: positiveNumber(options.looseGapY, DEFAULT_OPTIONS.looseGapY),
    looseMarginX: positiveNumber(options.looseMarginX, DEFAULT_OPTIONS.looseMarginX),
    looseColumns: positiveInteger(options.looseColumns, DEFAULT_OPTIONS.looseColumns),
    precision: positiveInteger(options.precision, DEFAULT_OPTIONS.precision)
  };
}

function roundPosition(position, precision) {
  return {
    x: roundNumber(position.x, precision),
    y: roundNumber(position.y, precision)
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function roundNumber(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
