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
  const noteList = normalizeNotes(notes);
  const allPaths = noteList.map((item) => item.path);
  const stats = options.stats instanceof Map ? options.stats : computeNoteLinkStats(noteList.map((item) => item.note));
  const policy = options.policy || getLabelVisibilityPolicy(options.zoom);
  const { resolvePath } = buildPathIndex(noteList);
  const forcedVisiblePaths = getForcedVisiblePaths(noteList, resolvePath, options);
  const automaticVisiblePaths = policy.showAll
    ? new Set(allPaths)
    : getAutomaticVisiblePaths(noteList, stats, policy);
  const visiblePaths = new Set([...automaticVisiblePaths, ...forcedVisiblePaths]);
  const hiddenPathList = allPaths.filter((path) => !visiblePaths.has(path));

  return {
    policy,
    stats,
    visiblePaths,
    hiddenPaths: new Set(hiddenPathList),
    visiblePathList: allPaths.filter((path) => visiblePaths.has(path)),
    hiddenPathList,
    automaticVisiblePaths,
    forcedVisiblePaths
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
  const pathNoExt = item.path.replace(/\.md$/i, "");
  const basename = pathNoExt.split("/").pop() || pathNoExt;
  const title = item.title;

  return [
    item.path,
    pathNoExt,
    basename,
    title,
    slugify(pathNoExt),
    slugify(basename),
    slugify(title)
  ]
    .filter(Boolean)
    .map(normalizeKey);
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

  if (Array.isArray(note.bodyRefNotes)) {
    for (const ref of note.bodyRefNotes) {
      values.push(ref && ref.note ? ref.note : ref);
    }
  }

  if (Array.isArray(note.bodyRefs)) {
    values.push(...note.bodyRefs.map((ref) => (ref && ref.ref ? ref.ref : ref)));
  }

  if (typeof note.body === "string") {
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(note.body)) !== null) {
      values.push(match[1]);
    }
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

function getAutomaticVisiblePaths(noteList, stats, policy) {
  const visible = new Set();
  const labelCap = Number.isFinite(policy.labelCap) ? policy.labelCap : Infinity;
  const ranked = rankNoteHubs(noteList.map((item) => item.note), stats);
  const rankedByPath = new Map(ranked.map((entry) => [entry.path, entry]));
  const levelCandidates = noteList
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

function compareLevel(a, b) {
  if (a === b) return 0;
  if (a === Infinity) return 1;
  if (b === Infinity) return -1;
  return a - b;
}

function cleanRef(value) {
  if (!value || value === "null") return null;
  const raw = typeof value === "string" ? value : getPath(value);
  if (!raw || raw === "null") return null;
  const wiki = String(raw).match(/\[\[([^\]]+)\]\]/);
  const ref = wiki ? wiki[1] : raw;
  return String(ref).split("|")[0].replace(/^notes\//i, "").replace(/\.md$/i, "").trim() || null;
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}
