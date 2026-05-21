import { LARGE_GRAPH_CONFIG } from "./graphConfig.js";

export function detectLargeGraphMode(metrics = {}, options = {}) {
  metrics = metrics || {};
  options = options || {};

  const noteCount = toCount(metrics.noteCount);
  const referenceEdgeCount = toCount(metrics.referenceEdgeCount);
  const noteCountThreshold = toPositiveCount(
    options.noteCountThreshold ?? options.noteThreshold,
    LARGE_GRAPH_CONFIG.noteCountThreshold
  );
  const referenceEdgeCountThreshold = toPositiveCount(
    options.referenceEdgeCountThreshold ?? options.referenceEdgeThreshold,
    LARGE_GRAPH_CONFIG.referenceEdgeCountThreshold
  );

  return noteCount > noteCountThreshold || referenceEdgeCount > referenceEdgeCountThreshold;
}

export function selectLargeModeReferenceEdges(referenceEdges = [], context = {}, options = {}) {
  context = context || {};
  options = options || {};

  const anchorPaths = collectAnchorPaths(context);
  if (!anchorPaths.size) return [];

  const maxEdgeCount = toPositiveCount(options.maxEdgeCount, Infinity);
  const selectedEdges = [];
  const seen = new Set();

  for (const edge of referenceEdges || []) {
    const from = getEndpointPath(edge, "from", "source", "sourcePath");
    const to = getEndpointPath(edge, "to", "target", "targetPath");
    if (!from || !to) continue;
    if (!anchorPaths.has(from) && !anchorPaths.has(to)) continue;

    const key = edge.key || edge.id || undirectedPairKey(from, to);
    if (seen.has(key)) continue;
    seen.add(key);

    selectedEdges.push(edge);
    if (selectedEdges.length >= maxEdgeCount) break;
  }

  return selectedEdges;
}

function collectAnchorPaths(context) {
  const paths = new Set();
  addPathValue(paths, context.selectedPath);
  addPathValue(paths, context.hoveredPath);
  addPathValue(paths, context.focusedPath);
  addPathValue(paths, context.focusPath);
  addPathValue(paths, context.activePath);
  addPathValue(paths, context.selectedPaths);
  addPathValue(paths, context.hoveredPaths);
  addPathValue(paths, context.focusedPaths);
  addPathValue(paths, context.searchMatchedPaths);
  addPathValue(paths, context.matchedPaths);
  addPathValue(paths, context.searchMatchedNotes);
  return paths;
}

function addPathValue(paths, value) {
  if (!value) return;

  if (typeof value === "string") {
    paths.add(value);
    return;
  }

  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) addPathValue(paths, item);
    return;
  }

  if (typeof value === "object" && typeof value.path === "string") {
    paths.add(value.path);
  }
}

function getEndpointPath(edge, primaryKey, objectKey, pathKey) {
  if (!edge) return null;

  const primaryValue = edge[primaryKey];
  if (typeof primaryValue === "string") return primaryValue;
  if (primaryValue && typeof primaryValue.path === "string") return primaryValue.path;

  const objectValue = edge[objectKey];
  if (typeof objectValue === "string") return objectValue;
  if (objectValue && typeof objectValue.path === "string") return objectValue.path;

  const pathValue = edge[pathKey];
  return typeof pathValue === "string" ? pathValue : null;
}

function undirectedPairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function toCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function toPositiveCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : fallback;
}
