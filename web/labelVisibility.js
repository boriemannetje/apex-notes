import {
  cleanWikiRef,
  getNoteAliasKeys,
  normalizeKey,
  parseWikiRefs
} from "./noteRefs.js";

const FAR_ZOOM_MAX = 0.6;
const MID_ZOOM_MAX = 0.95;
const NEAR_ZOOM_MAX = 1.45;

const FAR_LABEL_CAP = 40;
const FAR_HUB_PERCENT = 0.015;
const MID_LABEL_CAP = 80;
const MID_HUB_PERCENT = 0.05;
const NEAR_HUB_PERCENT = 0.15;

export function computeNoteLinkStats(notes = []) {
  const noteList = normalizeNotes(notes);
  const { byPath, resolvePath } = buildPathIndex(noteList);
  const working = new Map();
  const hierarchyEdges = new Set();
  const referenceEdges = new Set();

  for (const item of noteList) {
    working.set(item.path, {
      path: item.path,
      title: item.title,
      level: item.level,
      hierarchyParentCount: 0,
      hierarchyChildCount: 0,
      referenceInCount: 0,
      referenceOutCount: 0,
      incomingPaths: new Set(),
      outgoingPaths: new Set(),
      neighborPaths: new Set(),
      bodyIncomingPaths: new Set(),
      bodyOutgoingPaths: new Set(),
      bodyNeighborPaths: new Set()
    });
  }

  for (const item of noteList) {
    const parentPath = getParentPath(item.note, resolvePath);
    if (parentPath && parentPath !== item.path && byPath.has(parentPath)) {
      connectHierarchy(working, hierarchyEdges, parentPath, item.path);
    }

    for (const childPath of getChildPaths(item.note, resolvePath)) {
      if (childPath && childPath !== item.path && byPath.has(childPath)) {
        connectHierarchy(working, hierarchyEdges, item.path, childPath);
      }
    }

    for (const targetPath of getReferencePaths(item.note, resolvePath)) {
      if (targetPath && targetPath !== item.path && byPath.has(targetPath)) {
        connectReference(working, referenceEdges, item.path, targetPath);
      }
    }
  }

  const stats = new Map();
  for (const entry of working.values()) {
    const incomingPaths = [...entry.incomingPaths].sort(compareText);
    const outgoingPaths = [...entry.outgoingPaths].sort(compareText);
    const neighborPaths = [...entry.neighborPaths].sort(compareText);
    const bodyIncomingPaths = [...entry.bodyIncomingPaths].sort(compareText);
    const bodyOutgoingPaths = [...entry.bodyOutgoingPaths].sort(compareText);
    const bodyNeighborPaths = [...entry.bodyNeighborPaths].sort(compareText);
    const incomingLinkCount = entry.hierarchyChildCount + entry.referenceInCount;
    const outgoingLinkCount = entry.hierarchyParentCount + entry.referenceOutCount;
    const totalLinkCount = incomingLinkCount + outgoingLinkCount;

    stats.set(entry.path, {
      path: entry.path,
      title: entry.title,
      level: entry.level,
      hierarchyParentCount: entry.hierarchyParentCount,
      hierarchyChildCount: entry.hierarchyChildCount,
      referenceInCount: entry.referenceInCount,
      referenceOutCount: entry.referenceOutCount,
      incomingBodyLinks: entry.referenceInCount,
      outgoingBodyLinks: entry.referenceOutCount,
      bodyLinkDegree: bodyNeighborPaths.length,
      incomingLinkCount,
      outgoingLinkCount,
      totalLinkCount,
      uniqueNeighborCount: neighborPaths.length,
      hubScore: bodyNeighborPaths.length,
      hubRank: null,
      hubPercentile: null,
      incomingPaths,
      outgoingPaths,
      neighborPaths,
      bodyIncomingPaths,
      bodyOutgoingPaths,
      bodyNeighborPaths
    });
  }

  const ranked = [...stats.values()].sort(compareHubStats);
  ranked.forEach((entry, index) => {
    stats.set(entry.path, {
      ...entry,
      hubRank: index + 1,
      hubPercentile: ranked.length ? (index + 1) / ranked.length : 1
    });
  });

  return stats;
}

export function rankNoteHubs(notes = [], stats = null) {
  const statsMap = stats instanceof Map ? stats : computeNoteLinkStats(notes);
  const ranked = [...statsMap.values()].sort(compareHubStats);
  return ranked.map((entry, index) => ({
    ...entry,
    hubRank: entry.hubRank || index + 1,
    hubPercentile: entry.hubPercentile || (ranked.length ? (index + 1) / ranked.length : 1)
  }));
}

export function computeGraphCentralityScores(notes = [], options = {}) {
  const noteList = normalizeNotes(notes);
  const stats = options.stats instanceof Map
    ? options.stats
    : computeNoteLinkStats(noteList.map((item) => item.note));
  const paths = noteList.map((item) => item.path);
  const pageRank = computePageRank(paths, stats, options);
  const maxDegree = Math.max(1, ...paths.map((path) => {
    const entry = stats.get(path);
    return entry ? entry.uniqueNeighborCount || 0 : 0;
  }));
  const maxWeightedRefs = Math.max(1, ...paths.map((path) => {
    const entry = stats.get(path);
    return entry ? getWeightedReferenceScore(entry, options) : 0;
  }));
  const result = new Map();

  for (const path of paths) {
    const entry = stats.get(path) || {};
    const weightedReferenceScore = getWeightedReferenceScore(entry, options);
    result.set(path, {
      path,
      degreeCentrality: (entry.uniqueNeighborCount || 0) / maxDegree,
      linkDegree: entry.uniqueNeighborCount || 0,
      pageRank: pageRank.get(path) || 0,
      weightedReferenceScore,
      normalizedWeightedReferenceScore: weightedReferenceScore / maxWeightedRefs
    });
  }

  return result;
}

export function computeLabelScores(notes = [], options = {}) {
  const noteList = normalizeNotes(notes);
  const stats = options.stats instanceof Map
    ? options.stats
    : computeNoteLinkStats(noteList.map((item) => item.note));
  const graphCentrality = options.graphCentrality instanceof Map
    ? options.graphCentrality
    : computeGraphCentralityScores(noteList.map((item) => item.note), { ...options, stats });
  const centralityByPath = normalizeMetricSource(options.centrality || options.centralityByPath);
  const pageRankByPath = normalizeMetricSource(options.pageRank || options.pageRankByPath);
  const weightedRefsByPath = normalizeMetricSource(options.weightedRefs || options.weightedRefsByPath);
  const forcedPaths = normalizePathSet(options.forceVisiblePaths || options.forcedPaths);
  const selectedPaths = normalizePathSet(options.selectedPaths || options.selectedPath);
  const searchMatchedPaths = normalizePathSet(options.searchMatchedPaths || options.searchMatchedPath);
  const hoveredPaths = normalizePathSet(options.hoveredPaths || options.hoveredPath);
  const maxHubScore = Math.max(1, ...noteList.map((item) => stats.get(item.path)?.hubScore || 0));
  const maxReferenceIn = Math.max(1, ...noteList.map((item) => stats.get(item.path)?.referenceInCount || 0));
  const maxLevel = Math.max(1, ...noteList.map((item) => Number.isFinite(item.level) ? item.level : 0));
  const weights = {
    level: 0.35,
    hub: 0.3,
    centrality: 0.2,
    pageRank: 0.25,
    weightedRefs: 0.2,
    referenceIn: 0.15,
    forced: 100,
    selected: 10,
    search: 8,
    hovered: 2,
    ...(options.weights || {})
  };
  const scores = new Map();

  for (const item of noteList) {
    const entry = stats.get(item.path) || {};
    const centrality = graphCentrality.get(item.path) || {};
    const levelValue = Number.isFinite(item.level) ? 1 - Math.min(item.level, maxLevel) / (maxLevel + 1) : 0;
    const centralityValue = metricValue(centralityByPath, item.path, centrality.degreeCentrality || 0);
    const pageRankValue = metricValue(pageRankByPath, item.path, centrality.pageRank || 0);
    const weightedRefsValue = metricValue(
      weightedRefsByPath,
      item.path,
      centrality.normalizedWeightedReferenceScore || 0
    );
    const hubValue = (entry.hubScore || 0) / maxHubScore;
    const referenceInValue = (entry.referenceInCount || 0) / maxReferenceIn;
    const boost =
      (forcedPaths.has(item.path) ? weights.forced : 0) +
      (selectedPaths.has(item.path) ? weights.selected : 0) +
      (searchMatchedPaths.has(item.path) ? weights.search : 0) +
      (hoveredPaths.has(item.path) ? weights.hovered : 0);
    const score =
      boost +
      levelValue * weights.level +
      hubValue * weights.hub +
      centralityValue * weights.centrality +
      pageRankValue * weights.pageRank +
      weightedRefsValue * weights.weightedRefs +
      referenceInValue * weights.referenceIn;

    scores.set(item.path, {
      path: item.path,
      title: item.title,
      level: item.level,
      score,
      boost,
      levelScore: levelValue,
      hubScore: hubValue,
      centralityScore: centralityValue,
      pageRankScore: pageRankValue,
      weightedReferenceScore: weightedRefsValue,
      referenceInScore: referenceInValue,
      stats: entry,
      graphCentrality: centrality
    });
  }

  return scores;
}

export function rankLabelsByScore(notes = [], options = {}) {
  const scores = options.scores instanceof Map ? options.scores : computeLabelScores(notes, options);
  return [...scores.values()].sort(compareLabelScores);
}

export function selectNonOverlappingLabels(candidates = [], rectangles = null, options = {}) {
  const padding = Math.max(0, Number(options.padding) || 0);
  const maxLabels = Number.isFinite(Number(options.maxLabels)) ? Number(options.maxLabels) : Infinity;
  const allowMissingRect = options.allowMissingRect !== false;
  const protectedPaths = normalizePathSet(options.protectedPaths || options.forcedPaths);
  const normalizedCandidates = [...candidates]
    .map(normalizeLabelCandidate)
    .filter(Boolean)
    .sort(compareLabelScores);
  const selected = [];
  const rejected = [];
  const selectedRects = [];

  for (const candidate of normalizedCandidates) {
    if (selected.length >= maxLabels && !protectedPaths.has(candidate.path)) {
      rejected.push({ ...candidate, reason: "limit" });
      continue;
    }

    const rect = getLabelRect(rectangles, candidate.path);
    if (!rect) {
      if (allowMissingRect || protectedPaths.has(candidate.path)) {
        selected.push(candidate);
      } else {
        rejected.push({ ...candidate, reason: "missing-rect" });
      }
      continue;
    }

    const paddedRect = padRect(rect, padding);
    const overlaps = selectedRects.some((selectedRect) => rectsOverlap(paddedRect, selectedRect));
    if (!overlaps || protectedPaths.has(candidate.path)) {
      selected.push(candidate);
      selectedRects.push(paddedRect);
    } else {
      rejected.push({ ...candidate, reason: "overlap" });
    }
  }

  return {
    selected,
    rejected,
    selectedPaths: new Set(selected.map((candidate) => candidate.path)),
    rejectedPaths: new Set(rejected.map((candidate) => candidate.path)),
    selectedPathList: selected.map((candidate) => candidate.path),
    rejectedPathList: rejected.map((candidate) => candidate.path)
  };
}

export function prepareLabelVisibilityCache(notes = [], stats = null) {
  const noteList = normalizeNotes(notes);
  const allPaths = noteList.map((item) => item.path);
  const statsMap = stats instanceof Map ? stats : computeNoteLinkStats(noteList.map((item) => item.note));
  const { resolvePath } = buildPathIndex(noteList);
  const ranked = rankNoteHubs(noteList.map((item) => item.note), statsMap);
  const rankedByPath = new Map(ranked.map((entry) => [entry.path, entry]));
  const levelCandidates = [...noteList].sort((a, b) => compareLevelCandidate(a, b, rankedByPath));

  return {
    noteList,
    allPaths,
    stats: statsMap,
    resolvePath,
    ranked,
    rankedByPath,
    levelCandidates
  };
}

export function getLabelVisibilityPolicy(zoom = 1) {
  const scale = Number.isFinite(Number(zoom)) ? Number(zoom) : 1;

  if (scale < FAR_ZOOM_MAX) {
    return {
      name: "far",
      minZoom: 0,
      maxZoom: FAR_ZOOM_MAX,
      showAll: false,
      maxLevel: 1,
      hubPercent: FAR_HUB_PERCENT,
      labelCap: FAR_LABEL_CAP
    };
  }

  if (scale < MID_ZOOM_MAX) {
    return {
      name: "mid",
      minZoom: FAR_ZOOM_MAX,
      maxZoom: MID_ZOOM_MAX,
      showAll: false,
      maxLevel: 2,
      hubPercent: MID_HUB_PERCENT,
      labelCap: MID_LABEL_CAP
    };
  }

  if (scale < NEAR_ZOOM_MAX) {
    return {
      name: "near",
      minZoom: MID_ZOOM_MAX,
      maxZoom: NEAR_ZOOM_MAX,
      showAll: false,
      maxLevel: 3,
      hubPercent: NEAR_HUB_PERCENT,
      labelCap: Infinity
    };
  }

  return {
    name: "all",
    minZoom: NEAR_ZOOM_MAX,
    maxZoom: Infinity,
    showAll: true,
    maxLevel: Infinity,
    hubPercent: 1,
    labelCap: Infinity
  };
}

export function decideVisibleLabels(notes = [], options = {}) {
  const cache = options.cache || null;
  const noteList = cache ? cache.noteList : normalizeNotes(notes);
  const allPaths = cache ? cache.allPaths : noteList.map((item) => item.path);
  const stats = cache
    ? cache.stats
    : (options.stats instanceof Map ? options.stats : computeNoteLinkStats(noteList.map((item) => item.note)));
  const policy = options.policy || getLabelVisibilityPolicy(options.zoom);
  const resolvePath = cache ? cache.resolvePath : buildPathIndex(noteList).resolvePath;
  const forcedVisiblePaths = getForcedVisiblePaths(noteList, resolvePath, options);
  const automaticVisiblePaths = policy.showAll
    ? new Set(allPaths)
    : getAutomaticVisiblePaths(noteList, stats, policy, cache);
  let visiblePaths = new Set([...automaticVisiblePaths, ...forcedVisiblePaths]);
  let overlapSelection = null;

  if (options.labelRectangles) {
    const rankedLabels = rankLabelsByScore(noteList.map((item) => item.note), {
      ...options,
      stats,
      forceVisiblePaths: forcedVisiblePaths
    }).filter((entry) => visiblePaths.has(entry.path));
    overlapSelection = selectNonOverlappingLabels(rankedLabels, options.labelRectangles, {
      padding: options.labelOverlapPadding,
      maxLabels: policy.labelCap,
      protectedPaths: forcedVisiblePaths,
      allowMissingRect: options.allowMissingLabelRect
    });
    visiblePaths = overlapSelection.selectedPaths;
  }

  const hiddenPathList = allPaths.filter((path) => !visiblePaths.has(path));

  return {
    policy,
    stats,
    visiblePaths,
    hiddenPaths: new Set(hiddenPathList),
    visiblePathList: allPaths.filter((path) => visiblePaths.has(path)),
    hiddenPathList,
    automaticVisiblePaths,
    forcedVisiblePaths,
    overlapSelection
  };
}

function normalizeNotes(notes) {
  const noteArray = Array.isArray(notes) ? notes : [...notes || []];
  const normalized = [];
  const seen = new Set();

  for (const note of noteArray) {
    const path = getPath(note);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push({
      note,
      path,
      title: getTitle(note, path),
      level: getLevel(note)
    });
  }

  return normalized;
}

function buildPathIndex(noteList) {
  const byPath = new Map();
  const byAlias = new Map();

  for (const item of noteList) {
    byPath.set(item.path, item);
    for (const alias of getAliases(item)) {
      if (!byAlias.has(alias)) byAlias.set(alias, item.path);
    }
  }

  return {
    byPath,
    resolvePath(value) {
      const path = getPath(value);
      if (path && byPath.has(path)) return path;

      const cleaned = cleanRef(value);
      if (!cleaned) return null;
      if (byPath.has(cleaned)) return cleaned;

      return byAlias.get(normalizeKey(cleaned)) || null;
    }
  };
}

function getAliases(item) {
  return getNoteAliasKeys(item.path, item.title);
}

function getPath(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.path || value.id || null;
}

function getTitle(note, fallbackPath) {
  return String(note && note.title ? note.title : fallbackPath.split("/").pop() || fallbackPath);
}

function getLevel(note) {
  const level = Number(note && note.level);
  return Number.isFinite(level) ? level : Infinity;
}

function getParentPath(note, resolvePath) {
  const parent = note.parentNote || note.parentPath || note.parent || note.parentRef;
  return resolvePath(parent);
}

function getChildPaths(note, resolvePath) {
  if (!Array.isArray(note.children)) return [];
  return uniquePaths(note.children.map((child) => resolvePath(child)));
}

function getReferencePaths(note, resolvePath) {
  const values = [];

  if (Array.isArray(note.bodyRefNotes) && note.bodyRefNotes.length) {
    for (const ref of note.bodyRefNotes) {
      values.push(ref && ref.note ? ref.note : ref);
    }
  } else if (Array.isArray(note.bodyRefs) && note.bodyRefs.length) {
    values.push(...note.bodyRefs.map((ref) => (ref && ref.ref ? ref.ref : ref)));
  } else if (typeof note.body === "string") {
    values.push(...parseWikiRefs(note.body).map((ref) => ref.ref));
  }

  return uniquePaths(values.map((value) => resolvePath(value)));
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function connectHierarchy(stats, edgeKeys, parentPath, childPath) {
  const edgeKey = `${parentPath}->${childPath}`;
  if (edgeKeys.has(edgeKey)) return;
  edgeKeys.add(edgeKey);

  const parent = stats.get(parentPath);
  const child = stats.get(childPath);
  if (!parent || !child) return;

  parent.hierarchyChildCount += 1;
  child.hierarchyParentCount = 1;
  child.outgoingPaths.add(parentPath);
  parent.incomingPaths.add(childPath);
  parent.neighborPaths.add(childPath);
  child.neighborPaths.add(parentPath);
}

function connectReference(stats, edgeKeys, fromPath, toPath) {
  const edgeKey = `${fromPath}->${toPath}`;
  if (edgeKeys.has(edgeKey)) return;
  edgeKeys.add(edgeKey);

  const from = stats.get(fromPath);
  const to = stats.get(toPath);
  if (!from || !to) return;

  from.referenceOutCount += 1;
  to.referenceInCount += 1;
  from.outgoingPaths.add(toPath);
  to.incomingPaths.add(fromPath);
  from.neighborPaths.add(toPath);
  to.neighborPaths.add(fromPath);
  from.bodyOutgoingPaths.add(toPath);
  to.bodyIncomingPaths.add(fromPath);
  from.bodyNeighborPaths.add(toPath);
  to.bodyNeighborPaths.add(fromPath);
}

function getAutomaticVisiblePaths(noteList, stats, policy, cache = null) {
  const visible = new Set();
  const labelCap = Number.isFinite(policy.labelCap) ? policy.labelCap : Infinity;
  const ranked = cache ? cache.ranked : rankNoteHubs(noteList.map((item) => item.note), stats);
  const rankedByPath = cache ? cache.rankedByPath : new Map(ranked.map((entry) => [entry.path, entry]));
  const levelCandidates = cache
    ? cache.levelCandidates.filter((item) => item.level <= policy.maxLevel)
    : noteList
      .filter((item) => item.level <= policy.maxLevel)
      .sort((a, b) => compareLevelCandidate(a, b, rankedByPath));

  for (const item of levelCandidates) {
    if (visible.size >= labelCap) break;
    visible.add(item.path);
  }

  if (visible.size >= labelCap) return visible;

  const hubPercent = Number.isFinite(policy.hubPercent) ? policy.hubPercent : null;
  const percentHubLimit = hubPercent === null
    ? Infinity
    : Math.max(1, Math.ceil(noteList.length * hubPercent));
  const hubLimit = Math.min(percentHubLimit, ranked.length);
  for (const entry of ranked.slice(0, hubLimit)) {
    if (visible.size >= labelCap) break;
    if (entry.hubScore <= 0 || visible.has(entry.path)) continue;
    visible.add(entry.path);
  }

  return visible;
}

function getForcedVisiblePaths(noteList, resolvePath, options) {
  const forced = new Set();
  const add = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      const path = resolvePath(value);
      if (path) forced.add(path);
      return;
    }
    if (isIterable(value)) {
      for (const item of value) add(item);
      return;
    }
    const path = resolvePath(value);
    if (path) forced.add(path);
  };

  add(options.forceVisiblePaths);
  add(options.selectedPath);
  add(options.selectedPaths);
  add(options.hoveredPath);
  add(options.hoveredPaths);
  add(options.focusedPath);
  add(options.focusedPaths);
  add(options.searchMatchedPath);
  add(options.searchMatchedPaths);

  const searchQuery = String(options.searchQuery || "").trim().toLowerCase();
  if (searchQuery) {
    for (const item of noteList) {
      const searchText = getSearchText(item.note, item);
      if (searchText.includes(searchQuery)) forced.add(item.path);
    }
  }

  return forced;
}

function getSearchText(note, item) {
  return String(note.searchText || `${item.title} ${item.path}`).toLowerCase();
}

function isIterable(value) {
  return value && typeof value !== "string" && typeof value[Symbol.iterator] === "function";
}

function computePageRank(paths, stats, options = {}) {
  const damping = Number.isFinite(Number(options.pageRankDamping)) ? Number(options.pageRankDamping) : 0.85;
  const iterations = Number.isFinite(Number(options.pageRankIterations)) ? Number(options.pageRankIterations) : 20;
  const pathCount = paths.length;
  const baseScore = pathCount ? (1 - damping) / pathCount : 0;
  const ranks = new Map(paths.map((path) => [path, pathCount ? 1 / pathCount : 0]));
  const pathSet = new Set(paths);
  const adjacency = new Map(paths.map((path) => {
    const entry = stats.get(path);
    const outgoing = [];

    if (entry && entry.outgoingPaths) {
      for (const target of entry.outgoingPaths) {
        if (pathSet.has(target)) outgoing.push(target);
      }
    }

    return [path, outgoing];
  }));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map(paths.map((path) => [path, baseScore]));
    let danglingRank = 0;

    for (const path of paths) {
      const outgoing = adjacency.get(path) || [];
      const rank = ranks.get(path) || 0;

      if (!outgoing.length) {
        danglingRank += rank;
        continue;
      }

      const share = damping * rank / outgoing.length;
      for (const target of outgoing) next.set(target, (next.get(target) || 0) + share);
    }

    if (danglingRank) {
      const share = damping * danglingRank / Math.max(1, pathCount);
      for (const target of paths) next.set(target, (next.get(target) || 0) + share);
    }

    ranks.clear();
    for (const [path, rank] of next) ranks.set(path, rank);
  }

  const maxRank = Math.max(1e-9, ...ranks.values());
  for (const [path, rank] of ranks) ranks.set(path, rank / maxRank);
  return ranks;
}

function getWeightedReferenceScore(entry, options = {}) {
  const weights = {
    incomingBody: 2,
    outgoingBody: 1,
    hierarchyChild: 0.9,
    hierarchyParent: 0.45,
    ...(options.referenceWeights || {})
  };
  return (
    (entry.referenceInCount || 0) * weights.incomingBody +
    (entry.referenceOutCount || 0) * weights.outgoingBody +
    (entry.hierarchyChildCount || 0) * weights.hierarchyChild +
    (entry.hierarchyParentCount || 0) * weights.hierarchyParent
  );
}

function normalizeMetricSource(source) {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  if (Array.isArray(source)) {
    return new Map(source.map((entry) => {
      if (Array.isArray(entry)) return entry;
      return [entry.path || entry.id, metricValueFromEntry(entry)];
    }).filter(([path]) => path));
  }
  if (typeof source === "object") return new Map(Object.entries(source));
  return new Map();
}

function metricValue(source, path, fallback = 0) {
  if (!source || !source.has(path)) return fallback;
  return metricValueFromEntry(source.get(path), fallback);
}

function metricValueFromEntry(entry, fallback = 0) {
  if (typeof entry === "number") return Number.isFinite(entry) ? entry : fallback;
  if (!entry || typeof entry !== "object") return fallback;
  const value =
    entry.score ??
    entry.value ??
    entry.rank ??
    entry.pageRank ??
    entry.centrality ??
    entry.weightedReferenceScore ??
    fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePathSet(value) {
  const paths = new Set();
  const add = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      paths.add(item);
      return;
    }
    if (isIterable(item)) {
      for (const nested of item) add(nested);
      return;
    }
    const path = getPath(item);
    if (path) paths.add(path);
  };
  add(value);
  return paths;
}

function normalizeLabelCandidate(candidate) {
  if (!candidate) return null;
  if (typeof candidate === "string") return { path: candidate, score: 0, title: candidate };
  const path = getPath(candidate);
  if (!path) return null;
  return {
    ...candidate,
    path,
    title: candidate.title || path,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0
  };
}

function getLabelRect(rectangles, path) {
  if (!rectangles || !path) return null;
  let rect = null;
  if (rectangles instanceof Map) {
    rect = rectangles.get(path);
  } else if (Array.isArray(rectangles)) {
    const item = rectangles.find((entry) => {
      if (!entry) return false;
      if (Array.isArray(entry)) return entry[0] === path;
      return entry.path === path || entry.id === path;
    });
    rect = Array.isArray(item) ? item[1] : item && (item.rect || item);
  } else if (typeof rectangles === "object") {
    rect = rectangles[path];
  }

  return normalizeRect(rect);
}

function normalizeRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left ?? rect.x);
  const top = Number(rect.top ?? rect.y);
  const width = Number(rect.width ?? ((rect.right ?? 0) - left));
  const height = Number(rect.height ?? ((rect.bottom ?? 0) - top));
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return {
    left,
    top,
    right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
    bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height,
    width,
    height
  };
}

function padRect(rect, padding) {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding
  };
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function compareLevelCandidate(a, b, rankedByPath) {
  const aRank = rankedByPath.get(a.path);
  const bRank = rankedByPath.get(b.path);
  return (
    compareLevel(a.level, b.level) ||
    (aRank ? aRank.hubRank : Infinity) - (bRank ? bRank.hubRank : Infinity) ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

function compareHubStats(a, b) {
  return (
    b.hubScore - a.hubScore ||
    (b.incomingBodyLinks || 0) - (a.incomingBodyLinks || 0) ||
    (b.outgoingBodyLinks || 0) - (a.outgoingBodyLinks || 0) ||
    b.referenceInCount - a.referenceInCount ||
    compareLevel(a.level, b.level) ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

function compareLabelScores(a, b) {
  return (
    b.score - a.score ||
    compareLevel(a.level, b.level) ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

function compareLevel(a, b) {
  if (a === b) return 0;
  if (a === Infinity) return 1;
  if (b === Infinity) return -1;
  return a - b;
}

function cleanRef(value) {
  return cleanWikiRef(value);
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}
