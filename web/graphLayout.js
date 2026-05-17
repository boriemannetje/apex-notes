const DEFAULT_OPTIONS = Object.freeze({
  levelGap: 138,
  nodeGap: 168,
  subtreeGap: 168,
  rootGap: 224,
  collisionGap: 168,
  looseGapX: 168,
  looseGapY: 138,
  looseMarginX: 336,
  orderSweeps: 2,
  referenceRelaxation: false,
  referenceIterations: 4,
  referenceStrength: 0.18,
  precision: 3
});

export function buildGraphLayout(graph = {}, notes = [], options = {}) {
  const settings = normalizeOptions(options);
  const items = normalizeNotes(notes);
  if (!items.length) return new Map();

  const index = buildNoteIndex(items);
  const hierarchy = buildHierarchy(items, index);
  const references = buildReferenceAdjacency(graph, items, index, hierarchy.hierarchyPairs);

  orderHierarchyChildren(hierarchy, references, settings);

  const positions = layoutHierarchyForest(hierarchy, settings);
  if (settings.referenceRelaxation && references.size) {
    relaxReferencePositions(positions, hierarchy, references, settings);
  }
  enforceLevelGaps(positions, hierarchy.validPaths, settings);
  appendLooseGrid(positions, hierarchy.looseItems, settings);

  return roundPositions(positions, settings.precision);
}

function normalizeOptions(options) {
  const nodeGap = positiveNumber(options.nodeGap ?? options.xGap, DEFAULT_OPTIONS.nodeGap);

  return {
    levelGap: positiveNumber(options.levelGap, DEFAULT_OPTIONS.levelGap),
    nodeGap,
    subtreeGap: positiveNumber(options.subtreeGap, nodeGap),
    rootGap: positiveNumber(options.rootGap, DEFAULT_OPTIONS.rootGap),
    collisionGap: positiveNumber(options.collisionGap ?? options.legalGap, nodeGap),
    looseGapX: positiveNumber(options.looseGapX ?? options.looseGridGapX, nodeGap),
    looseGapY: positiveNumber(options.looseGapY ?? options.looseGridGapY, DEFAULT_OPTIONS.looseGapY),
    looseMarginX: positiveNumber(options.looseMarginX, DEFAULT_OPTIONS.looseMarginX),
    looseColumns: positiveInteger(options.looseColumns, 0),
    orderSweeps: positiveInteger(options.orderSweeps ?? options.barycentricSweeps, DEFAULT_OPTIONS.orderSweeps),
    referenceRelaxation: Boolean(options.referenceRelaxation || options.relaxReferences),
    referenceIterations: positiveInteger(options.referenceIterations, DEFAULT_OPTIONS.referenceIterations),
    referenceStrength: clampNumber(options.referenceStrength, 0, 1, DEFAULT_OPTIONS.referenceStrength),
    precision: positiveInteger(options.precision, DEFAULT_OPTIONS.precision)
  };
}

function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note && typeof note.path === "string" && note.path)
    .map((note, index) => ({
      note,
      index,
      path: note.path,
      title: String(note.title || basenameWithoutExtension(note.path)),
      level: toFiniteNumber(note.level),
      parentPath: null,
      hasParentRef: false,
      derivedLevel: null,
      children: []
    }));
}

function buildNoteIndex(items) {
  const byPath = new Map();
  const byAlias = new Map();

  for (const item of items) {
    byPath.set(item.path, item);
  }

  for (const item of items) {
    addAlias(byAlias, item.path, item);
    addAlias(byAlias, stripMarkdownExtension(item.path), item);
    addAlias(byAlias, basenameWithoutExtension(item.path), item);
    addAlias(byAlias, item.title, item);

    for (const key of item.note.keys || []) {
      addAlias(byAlias, key, item);
    }
  }

  return { byPath, byAlias };
}

function buildHierarchy(items, index) {
  const childrenByParent = new Map();
  const roots = [];
  const validPaths = new Set();
  const hierarchyPairs = new Set();

  for (const item of items) {
    item.hasParentRef = hasHierarchyParentRef(item.note);
    item.parentPath = resolveParentPath(item.note, index);
    item.children = [];
    item.derivedLevel = null;
  }

  for (const item of items) {
    if (!item.parentPath && !item.hasParentRef) {
      roots.push(item);
      continue;
    }

    const parent = item.parentPath ? index.byPath.get(item.parentPath) : null;
    if (!parent) continue;

    if (!childrenByParent.has(parent.path)) childrenByParent.set(parent.path, []);
    childrenByParent.get(parent.path).push(item);
    hierarchyPairs.add(pairKey(parent.path, item.path));
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareItems);
  }
  roots.sort(compareItems);

  const visit = (item, level, visiting) => {
    if (visiting.has(item.path)) return;
    if (validPaths.has(item.path)) return;

    visiting.add(item.path);
    validPaths.add(item.path);
    item.derivedLevel = level;
    item.children = childrenByParent.get(item.path) || [];

    for (const child of item.children) {
      visit(child, level + 1, visiting);
    }
    visiting.delete(item.path);
  };

  for (const root of roots) {
    visit(root, 0, new Set());
  }

  return {
    roots: roots.filter((root) => validPaths.has(root.path)),
    looseItems: items.filter((item) => !validPaths.has(item.path)).sort(compareItems),
    validPaths,
    hierarchyPairs
  };
}

function orderHierarchyChildren(hierarchy, references, settings) {
  if (!references.size || settings.orderSweeps <= 0) return;

  let positions = layoutHierarchyForest(hierarchy, settings);
  for (let sweep = 0; sweep < settings.orderSweeps; sweep += 1) {
    const parents = collectHierarchyItems(hierarchy.roots)
      .sort((a, b) => a.derivedLevel - b.derivedLevel || compareItems(a, b));

    for (const parent of parents) {
      if (parent.children.length < 2) continue;
      const currentOrder = new Map(parent.children.map((child, index) => [child.path, index]));
      parent.children.sort((a, b) => {
        const baryA = referenceBarycenter(a.path, references, positions);
        const baryB = referenceBarycenter(b.path, references, positions);
        const aHas = Number.isFinite(baryA);
        const bHas = Number.isFinite(baryB);
        if (aHas && bHas && baryA !== baryB) return baryA - baryB;
        if (aHas !== bHas) return aHas ? -1 : 1;
        return currentOrder.get(a.path) - currentOrder.get(b.path) || compareItems(a, b);
      });
    }
    positions = layoutHierarchyForest(hierarchy, settings);
  }
}

function layoutHierarchyForest(hierarchy, settings) {
  const positions = new Map();
  let cursor = 0;

  for (const root of hierarchy.roots) {
    const subtree = layoutSubtree(root, settings);
    const shift = cursor - subtree.minX;

    for (const point of subtree.points) {
      positions.set(point.path, {
        x: point.x + shift,
        y: point.level * settings.levelGap
      });
    }

    cursor += subtree.width + settings.rootGap;
  }

  return positions;
}

function layoutSubtree(item, settings) {
  if (!item.children.length) {
    return {
      rootX: 0,
      minX: 0,
      maxX: 0,
      width: 0,
      points: [{ path: item.path, x: 0, level: item.derivedLevel }]
    };
  }

  let cursor = 0;
  const childLayouts = [];

  for (const child of item.children) {
    const layout = layoutSubtree(child, settings);
    const shift = childLayouts.length ? cursor + settings.subtreeGap - layout.minX : -layout.minX;
    const shifted = {
      rootX: layout.rootX + shift,
      minX: layout.minX + shift,
      maxX: layout.maxX + shift,
      points: layout.points.map((point) => ({
        ...point,
        x: point.x + shift
      }))
    };

    childLayouts.push(shifted);
    cursor = shifted.maxX;
  }

  const first = childLayouts[0];
  const last = childLayouts[childLayouts.length - 1];
  const rootX = (first.rootX + last.rootX) / 2;
  const points = [{ path: item.path, x: 0, level: item.derivedLevel }];
  let minX = 0;
  let maxX = 0;

  for (const childLayout of childLayouts) {
    for (const point of childLayout.points) {
      const x = point.x - rootX;
      points.push({ path: point.path, x, level: point.level });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }

  return {
    rootX: 0,
    minX,
    maxX,
    width: maxX - minX,
    points
  };
}

function relaxReferencePositions(positions, hierarchy, references, settings) {
  const paths = [...hierarchy.validPaths].filter((path) => positions.has(path));
  if (paths.length < 2) return;

  for (let iteration = 0; iteration < settings.referenceIterations; iteration += 1) {
    const nextX = new Map();

    for (const path of paths) {
      const barycenter = referenceBarycenter(path, references, positions);
      const current = positions.get(path);
      if (!Number.isFinite(barycenter) || !current) continue;
      nextX.set(path, current.x + (barycenter - current.x) * settings.referenceStrength);
    }

    for (const [path, x] of nextX.entries()) {
      const current = positions.get(path);
      positions.set(path, { x, y: current.y });
    }
    enforceLevelGaps(positions, hierarchy.validPaths, settings);
  }
}

function enforceLevelGaps(positions, paths, settings) {
  const levels = new Map();

  for (const path of paths) {
    const position = positions.get(path);
    if (!position) continue;
    const key = String(position.y);
    if (!levels.has(key)) levels.set(key, []);
    levels.get(key).push({ path, position });
  }

  for (const levelItems of levels.values()) {
    levelItems.sort((a, b) => a.position.x - b.position.x || compareText(a.path, b.path));
    for (let index = 1; index < levelItems.length; index += 1) {
      const previous = levelItems[index - 1].position;
      const current = levelItems[index].position;
      const minX = previous.x + settings.collisionGap;
      if (current.x < minX) {
        current.x = minX;
      }
    }
  }
}

function appendLooseGrid(positions, looseItems, settings) {
  if (!looseItems.length) return;

  const bounds = getBounds(positions);
  const columns = settings.looseColumns || Math.max(1, Math.ceil(Math.sqrt(looseItems.length)));
  const startX = bounds ? bounds.maxX + settings.looseMarginX : 0;
  const startY = bounds ? bounds.minY : 0;

  looseItems.forEach((item, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    positions.set(item.path, {
      x: startX + column * settings.looseGapX,
      y: startY + row * settings.looseGapY
    });
  });
}

function buildReferenceAdjacency(graph, items, index, hierarchyPairs) {
  const adjacency = new Map();
  const add = (fromPath, toPath) => {
    if (!fromPath || !toPath || fromPath === toPath) return;
    if (!index.byPath.has(fromPath) || !index.byPath.has(toPath)) return;
    if (hierarchyPairs.has(pairKey(fromPath, toPath))) return;
    if (!adjacency.has(fromPath)) adjacency.set(fromPath, new Set());
    if (!adjacency.has(toPath)) adjacency.set(toPath, new Set());
    adjacency.get(fromPath).add(toPath);
    adjacency.get(toPath).add(fromPath);
  };

  for (const edge of collectGraphEdges(graph)) {
    if (isHierarchyEdge(edge)) continue;
    add(resolveEndpoint(edge.from ?? edge.source ?? edge.sourcePath, index), resolveEndpoint(edge.to ?? edge.target ?? edge.targetPath, index));
  }

  for (const item of items) {
    for (const ref of item.note.bodyRefNotes || []) {
      add(item.path, resolveEndpoint(ref.note ?? ref.path ?? ref.ref, index));
    }
    for (const ref of item.note.bodyRefs || []) {
      add(item.path, resolveEndpoint(ref.note ?? ref.path ?? ref.ref, index));
    }
  }

  return adjacency;
}

function collectGraphEdges(graph) {
  if (!graph || typeof graph !== "object") return [];
  if (Array.isArray(graph)) return graph;
  return [
    ...(Array.isArray(graph.referenceEdges) ? graph.referenceEdges : []),
    ...(Array.isArray(graph.edges) ? graph.edges : []),
    ...(Array.isArray(graph.links) ? graph.links : [])
  ];
}

function collectHierarchyItems(roots) {
  const items = [];
  const visit = (item) => {
    items.push(item);
    for (const child of item.children) visit(child);
  };
  for (const root of roots) visit(root);
  return items;
}

function referenceBarycenter(path, references, positions) {
  const neighbors = references.get(path);
  if (!neighbors || !neighbors.size) return NaN;

  let total = 0;
  let count = 0;
  for (const neighbor of neighbors) {
    const position = positions.get(neighbor);
    if (!position) continue;
    total += position.x;
    count += 1;
  }

  return count ? total / count : NaN;
}

function resolveParentPath(note, index) {
  const direct = resolveEndpoint(note.parentNote ?? note.parentPath, index);
  if (direct) return direct;

  const ref = note.parentRef ?? note.parent ?? note.frontmatter?.parent ?? null;
  return resolveEndpoint(ref, index);
}

function hasHierarchyParentRef(note) {
  if (!note) return false;
  const direct = note.parentNote ?? note.parentPath;
  if (typeof direct === "object" && typeof direct?.path === "string") return true;
  if (typeof direct === "string" && cleanWikiRef(direct)) return true;

  const ref = note.parentRef ?? note.parent ?? note.frontmatter?.parent ?? null;
  return Boolean(cleanWikiRef(ref));
}

function resolveEndpoint(value, index) {
  if (!value) return null;
  if (typeof value === "object" && typeof value.path === "string") {
    return index.byPath.has(value.path) ? value.path : null;
  }

  if (typeof value !== "string") return null;
  const clean = cleanWikiRef(value);
  if (!clean) return null;
  if (index.byPath.has(clean)) return clean;

  return index.byAlias.get(aliasKey(clean))?.path || null;
}

function roundPositions(positions, precision) {
  const rounded = new Map();
  for (const [path, position] of positions.entries()) {
    rounded.set(path, {
      x: roundNumber(position.x, precision),
      y: roundNumber(position.y, precision)
    });
  }
  return rounded;
}

function getBounds(positions) {
  if (!positions.size) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    maxX = Math.max(maxX, position.x);
    minY = Math.min(minY, position.y);
    maxY = Math.max(maxY, position.y);
  }

  return { minX, maxX, minY, maxY };
}

function addAlias(byAlias, value, item) {
  const key = aliasKey(value);
  if (!key || byAlias.has(key)) return;
  byAlias.set(key, item);
}

function isHierarchyEdge(edge) {
  return edge && (edge.type === "hierarchy" || edge.kind === "hierarchy");
}

function cleanWikiRef(value) {
  const text = String(value || "").trim();
  if (!text || text === "null") return "";
  const match = text.match(/^\[\[([^\]]+)\]\]$/);
  const ref = match ? match[1] : text;
  return ref.split("#")[0].split("|")[0].trim();
}

function aliasKey(value) {
  return cleanWikiRef(value).toLowerCase();
}

function stripMarkdownExtension(path) {
  return String(path || "").replace(/\.md$/i, "");
}

function basenameWithoutExtension(path) {
  return stripMarkdownExtension(String(path || "").split("/").pop() || "");
}

function compareItems(a, b) {
  return compareText(a.title, b.title) || compareText(a.path, b.path) || a.index - b.index;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function roundNumber(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
