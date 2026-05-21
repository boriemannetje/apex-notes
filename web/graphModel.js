import { cleanWikiRef, getNoteAliasKeys, normalizeKey, parseWikiTarget, slugify } from "./noteRefs.js";

export const ISSUE_TYPES = Object.freeze({
  MISSING_PARENT: "missing-parent",
  CYCLE: "cycle",
  DISCONNECTED: "disconnected",
  LEVEL_MISMATCH: "level-mismatch",
  DUPLICATE_ALIAS: "duplicate-alias"
});

export function createGraphIndex(notes, options = {}) {
  const noteList = Array.isArray(notes) ? notes : [];
  const getId = typeof options.getId === "function" ? options.getId : defaultGetId;
  const includeSelfRefs = options.includeSelfRefs === true;
  const includeParentRefs = options.includeParentRefs === true;
  const V = new Map();
  const byPath = new Map();
  const aliasBuckets = new Map();
  const duplicateAliases = new Map();

  for (let index = 0; index < noteList.length; index += 1) {
    const note = noteList[index];
    const path = getId(note, index);
    const vertex = normalizeVertex(note, path, index);
    V.set(path, vertex);
    byPath.set(path, vertex);
  }

  for (const vertex of V.values()) {
    for (const alias of getAliases(vertex)) {
      if (!aliasBuckets.has(alias)) aliasBuckets.set(alias, []);
      aliasBuckets.get(alias).push(vertex.path);
    }
  }

  for (const [alias, paths] of aliasBuckets) {
    const uniquePaths = unique(paths);
    if (uniquePaths.length > 1) duplicateAliases.set(alias, uniquePaths);
    aliasBuckets.set(alias, uniquePaths);
  }

  const aliasToPath = new Map();
  for (const [alias, paths] of aliasBuckets) {
    if (paths.length === 1) aliasToPath.set(alias, paths[0]);
  }

  const resolvePath = (value) => resolveNotePath(value, byPath, aliasToPath);
  const parents = new Map();
  const children = new Map();
  const refsOut = new Map();
  const refsIn = new Map();
  const E_tree = [];
  const E_ref = [];
  const refWeights = new Map();
  const missingParentIssues = [];

  for (const path of V.keys()) {
    parents.set(path, null);
    children.set(path, []);
    refsOut.set(path, new Map());
    refsIn.set(path, new Map());
  }

  for (const vertex of V.values()) {
    const parentRef = cleanWikiRef(getParentRef(vertex.note));
    vertex.parentRef = parentRef;
    if (!parentRef) continue;

    const parentPath = resolvePath(parentRef);
    if (!parentPath) {
      missingParentIssues.push({
        type: ISSUE_TYPES.MISSING_PARENT,
        path: vertex.path,
        ref: parentRef,
        message: `${vertex.title} has a missing parent [[${parentRef}]]`
      });
      continue;
    }

    parents.set(vertex.path, parentPath);
    children.get(parentPath).push(vertex.path);
    E_tree.push({
      from: parentPath,
      to: vertex.path,
      parent: parentPath,
      child: vertex.path,
      ref: parentRef,
      type: "tree"
    });
  }

  const hierarchyPairs = new Set(E_tree.map((edge) => pairKey(edge.from, edge.to)));

  for (const vertex of V.values()) {
    for (const ref of getReferenceRefs(vertex.note)) {
      const targetPath = resolvePath(ref.ref);
      if (!targetPath) continue;
      if (!includeSelfRefs && targetPath === vertex.path) continue;
      if (!includeParentRefs && hierarchyPairs.has(pairKey(vertex.path, targetPath))) continue;
      addWeightedReference(refWeights, refsOut, refsIn, vertex.path, targetPath, ref);
    }
  }

  for (const weighted of refWeights.values()) {
    E_ref.push({
      from: weighted.from,
      to: weighted.to,
      weight: weighted.weight,
      refs: weighted.refs,
      type: "ref"
    });
  }

  const derivedLevels = deriveLevels(V, parents, children);
  for (const [path, level] of derivedLevels) {
    const vertex = V.get(path);
    vertex.derivedLevel = level;
    if (!Number.isFinite(vertex.declaredLevel)) {
      vertex.level = level;
    }
  }

  const validation = validateGraph({
    V,
    parents,
    children,
    E_tree,
    missingParentIssues,
    duplicateAliases,
    derivedLevels
  });

  const roots = getRootPaths(V);

  return {
    V,
    E_tree,
    E_ref,
    parents,
    children,
    refsOut,
    refsIn,
    byPath,
    aliases: aliasToPath,
    aliasBuckets,
    duplicateAliases,
    roots,
    derivedLevels,
    validation,
    issues: validation,
    resolvePath,
    resolveNote(value) {
      const path = resolvePath(value);
      return path ? V.get(path) || null : null;
    },
    getParent(path) {
      const parentPath = parents.get(path);
      return parentPath ? V.get(parentPath) || null : null;
    },
    getChildren(path) {
      return (children.get(path) || []).map((childPath) => V.get(childPath)).filter(Boolean);
    },
    getRefsOut(path) {
      return refsOut.get(path) || new Map();
    },
    getRefsIn(path) {
      return refsIn.get(path) || new Map();
    }
  };
}

export function resolveNotePath(value, byPath, aliases) {
  const directPath = getPath(value);
  if (directPath && byPath.has(directPath)) return directPath;

  const ref = cleanWikiRef(value);
  if (!ref) return null;
  if (byPath.has(ref)) return ref;

  return (
    aliases.get(normalizeKey(ref)) ||
    aliases.get(normalizeKey(slugify(ref))) ||
    null
  );
}

export function deriveLevels(V, parents, children) {
  const levels = new Map();
  const roots = getRootPaths(V);
  const queue = roots.map((path) => [path, 0]);

  for (let index = 0; index < queue.length; index += 1) {
    const [path, level] = queue[index];
    if (levels.has(path)) continue;
    levels.set(path, level);

    for (const childPath of children.get(path) || []) {
      queue.push([childPath, level + 1]);
    }
  }

  return levels;
}

export function validateGraph({
  V,
  parents,
  children,
  E_tree,
  missingParentIssues = [],
  duplicateAliases = new Map(),
  derivedLevels = new Map()
}) {
  const issues = [];

  issues.push(...missingParentIssues);

  for (const [alias, paths] of duplicateAliases) {
    issues.push({
      type: ISSUE_TYPES.DUPLICATE_ALIAS,
      alias,
      paths,
      message: `Alias "${alias}" resolves to ${paths.length} notes`
    });
  }

  for (const issue of findCycles(V, parents)) {
    issues.push(issue);
  }

  for (const [path, vertex] of V) {
    const parentPath = parents.get(path);
    const declaredLevel = vertex.declaredLevel;
    const derivedLevel = derivedLevels.get(path);

    if (Number.isFinite(declaredLevel) && Number.isFinite(derivedLevel) && declaredLevel !== derivedLevel) {
      issues.push({
        type: ISSUE_TYPES.LEVEL_MISMATCH,
        path,
        level: declaredLevel,
        derivedLevel,
        message: `${vertex.title} is level ${declaredLevel}, expected ${derivedLevel}`
      });
    }

    if (parentPath && derivedLevels.has(parentPath) && derivedLevels.has(path)) {
      const expected = derivedLevels.get(parentPath) + 1;
      if (derivedLevels.get(path) !== expected) {
        issues.push({
          type: ISSUE_TYPES.LEVEL_MISMATCH,
          path,
          parentPath,
          derivedLevel: derivedLevels.get(path),
          expected,
          message: `${vertex.title} is not one level below its parent`
        });
      }
    }
  }

  for (const edge of E_tree) {
    if (!V.has(edge.from) || !V.has(edge.to)) {
      issues.push({
        type: ISSUE_TYPES.DISCONNECTED,
        edge,
        message: "Tree edge points outside the vertex set"
      });
    }
  }

  return issues;
}

function normalizeVertex(note, path, index) {
  const title = getTitle(note, path);
  const declaredLevel = getDeclaredLevel(note);

  return {
    path,
    id: path,
    index,
    note,
    title,
    declaredLevel,
    level: Number.isFinite(declaredLevel) ? declaredLevel : null,
    derivedLevel: null,
    parentRef: cleanWikiRef(getParentRef(note)),
    aliases: []
  };
}

function getRootPaths(V) {
  return [...V.values()]
    .filter((vertex) => !cleanWikiRef(vertex.parentRef))
    .map((vertex) => vertex.path);
}

function defaultGetId(note, index) {
  return getPath(note) || `__note_${index}`;
}

function getPath(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.path || value.id || null;
}

function getTitle(note, fallbackPath) {
  return String(note && note.title ? note.title : fallbackPath.split("/").pop() || fallbackPath);
}

function getDeclaredLevel(note) {
  if (!note || !Object.prototype.hasOwnProperty.call(note, "level")) return null;
  const level = Number(note.level);
  return Number.isFinite(level) ? level : null;
}

function getParentRef(note) {
  if (!note) return null;
  if (Object.prototype.hasOwnProperty.call(note, "parentRef")) return note.parentRef;
  if (note.frontmatterValues && Object.prototype.hasOwnProperty.call(note.frontmatterValues, "parent")) {
    return note.frontmatterValues.parent;
  }
  if (Object.prototype.hasOwnProperty.call(note, "parent")) return note.parent;
  if (Object.prototype.hasOwnProperty.call(note, "parentPath")) return note.parentPath;
  return null;
}

function getReferenceRefs(note) {
  if (!note) return [];
  if (typeof note.body === "string") {
    return parseWikiRefsWithMultiplicity(note.body);
  }
  if (typeof note.raw === "string") {
    return parseWikiRefsWithMultiplicity(stripFrontmatter(note.raw));
  }
  if (Array.isArray(note.bodyRefs)) {
    return note.bodyRefs.map((ref) => normalizeRef(ref)).filter(Boolean);
  }
  if (Array.isArray(note.refs)) {
    return note.refs.map((ref) => normalizeRef(ref)).filter(Boolean);
  }
  return [];
}

function parseWikiRefsWithMultiplicity(text) {
  const refs = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    const parsed = parseWikiTarget(match[1]);
    if (parsed && parsed.ref) refs.push(parsed);
  }

  return refs;
}

function normalizeRef(ref) {
  if (!ref) return null;
  if (typeof ref === "string") {
    const parsed = parseWikiTarget(ref);
    return parsed.ref ? parsed : { ref, label: ref };
  }
  if (ref.ref) return { ...ref, ref: cleanWikiRef(ref.ref) || ref.ref };
  if (ref.path || ref.id) {
    const value = ref.path || ref.id;
    return { ...ref, ref: value, label: ref.label || value };
  }
  return null;
}

function getAliases(vertex) {
  const aliases = getNoteAliasKeys(vertex.path, vertex.title);
  vertex.aliases = aliases;
  return aliases;
}

function addWeightedReference(refWeights, refsOut, refsIn, from, to, ref) {
  const key = `${from}->${to}`;
  if (!refWeights.has(key)) {
    refWeights.set(key, {
      from,
      to,
      weight: 0,
      refs: []
    });
  }

  const weighted = refWeights.get(key);
  weighted.weight += 1;
  weighted.refs.push(ref);
  incrementMap(refsOut.get(from), to);
  incrementMap(refsIn.get(to), from);
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function findCycles(V, parents) {
  const issues = [];
  const emitted = new Set();
  const resolved = new Set();

  for (const path of V.keys()) {
    if (resolved.has(path)) continue;

    const stack = [];
    const seenAt = new Map();
    let current = path;

    while (current && V.has(current)) {
      if (resolved.has(current)) break;

      if (seenAt.has(current)) {
        const cycle = stack.slice(seenAt.get(current));
        const key = [...cycle].sort().join("|");
        if (!emitted.has(key)) {
          emitted.add(key);
          issues.push({
            type: ISSUE_TYPES.CYCLE,
            paths: cycle,
            message: `Cycle detected: ${cycle.join(" -> ")}`
          });
        }
        break;
      }

      seenAt.set(current, stack.length);
      stack.push(current);
      current = parents.get(current);
    }

    for (const resolvedPath of stack) {
      resolved.add(resolvedPath);
    }
  }

  return issues;
}

function pairKey(a, b) {
  return a < b ? `${a}<->${b}` : `${b}<->${a}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---")) return text;
  const endIndex = text.indexOf("\n---", 3);
  return endIndex === -1 ? text : text.slice(endIndex + 4);
}
