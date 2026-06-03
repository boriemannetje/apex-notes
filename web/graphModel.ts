import { cleanWikiRef, getNoteAliasKeys, normalizeKey, parseWikiTarget, slugify } from "./noteRefs.ts";

export const ISSUE_TYPES = Object.freeze({
  MISSING_PARENT: "missing-parent",
  CYCLE: "cycle",
  DISCONNECTED: "disconnected",
  DUPLICATE_ALIAS: "duplicate-alias"
});

type GraphNote = {
  path?: unknown;
  id?: unknown;
  title?: unknown;
  parentRef?: unknown;
  parent?: unknown;
  parentPath?: unknown;
  frontmatterValues?: {
    parent?: unknown;
    [key: string]: unknown;
  };
  body?: unknown;
  raw?: unknown;
  bodyRefs?: unknown[];
  refs?: unknown[];
};

interface CreateGraphIndexOptions {
  getId?: (note: GraphNote, index: number) => string;
  includeSelfRefs?: boolean;
  includeParentRefs?: boolean;
}

interface GraphReference {
  ref: string;
  label?: string;
  [key: string]: unknown;
}

export interface GraphVertex {
  path: string;
  id: string;
  index: number;
  note: GraphNote;
  title: string;
  level: number | null;
  derivedLevel: number | null;
  parentRef: string | null;
  aliases: string[];
}

export interface TreeEdge {
  from: string;
  to: string;
  parent: string;
  child: string;
  ref: string;
  type: "tree";
}

export interface ReferenceEdge {
  from: string;
  to: string;
  weight: number;
  refs: GraphReference[];
  type: "ref";
}

export interface GraphIssue {
  type: string;
  path?: string;
  paths?: string[];
  edge?: TreeEdge;
  ref?: string;
  message: string;
  [key: string]: unknown;
}

interface WeightedReference {
  from: string;
  to: string;
  weight: number;
  refs: GraphReference[];
}

interface ValidateGraphInput {
  V: Map<string, GraphVertex>;
  parents: Map<string, string | null>;
  children: Map<string, string[]>;
  E_tree: TreeEdge[];
  missingParentIssues?: GraphIssue[];
  duplicateAliases?: Map<string, string[]>;
  derivedLevels?: Map<string, number>;
}

export interface GraphIndex {
  V: Map<string, GraphVertex>;
  E_tree: TreeEdge[];
  E_ref: ReferenceEdge[];
  parents: Map<string, string | null>;
  children: Map<string, string[]>;
  refsOut: Map<string, Map<string, number>>;
  refsIn: Map<string, Map<string, number>>;
  byPath: Map<string, GraphVertex>;
  aliases: Map<string, string>;
  aliasBuckets: Map<string, string[]>;
  duplicateAliases: Map<string, string[]>;
  roots: string[];
  derivedLevels: Map<string, number>;
  validation: GraphIssue[];
  issues: GraphIssue[];
  resolvePath: (value: unknown) => string | null;
  resolveNote: (value: unknown) => GraphVertex | null;
  getParent: (path: string) => GraphVertex | null;
  getChildren: (path: string) => GraphVertex[];
  getRefsOut: (path: string) => Map<string, number>;
  getRefsIn: (path: string) => Map<string, number>;
}

const NULLISH_PARENT_REFS = new Set(["", "null", "undefined", "~"]);

export function createGraphIndex(
  notes: GraphNote[] | null | undefined,
  options: CreateGraphIndexOptions = {}
): GraphIndex {
  const noteList: GraphNote[] = Array.isArray(notes) ? notes : [];
  const getId = typeof options.getId === "function" ? options.getId : defaultGetId;
  const includeSelfRefs = options.includeSelfRefs === true;
  const includeParentRefs = options.includeParentRefs === true;
  const V = new Map<string, GraphVertex>();
  const byPath = new Map<string, GraphVertex>();
  const aliasBuckets = new Map<string, string[]>();
  const duplicateAliases = new Map<string, string[]>();

  for (let index = 0; index < noteList.length; index += 1) {
    const note = noteList[index];
    const path = getId(note, index);
    const vertex = normalizeVertex(note, path, index);
    V.set(path, vertex);
    byPath.set(path, vertex);
  }

  for (const vertex of V.values()) {
    for (const alias of getAliases(vertex)) {
      let paths = aliasBuckets.get(alias);
      if (!paths) {
        paths = [];
        aliasBuckets.set(alias, paths);
      }
      paths.push(vertex.path);
    }
  }

  for (const [alias, paths] of aliasBuckets) {
    const uniquePaths = unique(paths);
    if (uniquePaths.length > 1) duplicateAliases.set(alias, uniquePaths);
    aliasBuckets.set(alias, uniquePaths);
  }

  const aliasToPath = new Map<string, string>();
  for (const [alias, paths] of aliasBuckets) {
    if (paths.length === 1) aliasToPath.set(alias, paths[0]);
  }

  const resolvePath = (value: unknown): string | null => resolveNotePath(value, byPath, aliasToPath);
  const parents = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const refsOut = new Map<string, Map<string, number>>();
  const refsIn = new Map<string, Map<string, number>>();
  const E_tree: TreeEdge[] = [];
  const E_ref: ReferenceEdge[] = [];
  const refWeights = new Map<string, WeightedReference>();
  const missingParentIssues: GraphIssue[] = [];

  for (const path of V.keys()) {
    parents.set(path, null);
    children.set(path, []);
    refsOut.set(path, new Map());
    refsIn.set(path, new Map());
  }

  for (const vertex of V.values()) {
    const parentRef = cleanWikiRef(getParentRef(vertex.note)) || null;
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
    children.get(parentPath)?.push(vertex.path);
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
    vertex.level = level;
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
    resolveNote(value: unknown) {
      const path = resolvePath(value);
      return path ? V.get(path) || null : null;
    },
    getParent(path: string) {
      const parentPath = parents.get(path);
      return parentPath ? V.get(parentPath) || null : null;
    },
    getChildren(path: string) {
      return (children.get(path) || []).map((childPath) => V.get(childPath)).filter(Boolean);
    },
    getRefsOut(path: string) {
      return refsOut.get(path) || new Map();
    },
    getRefsIn(path: string) {
      return refsIn.get(path) || new Map();
    }
  };
}

export function resolveNotePath(
  value: unknown,
  byPath: Map<string, unknown>,
  aliases: Map<string, string>
): string | null {
  const directPath = getPath(value);
  if (directPath && byPath.has(directPath)) return directPath;

  const ref = cleanWikiRef(value);
  if (!ref) return null;
  if (byPath.has(ref)) return ref;

  const markdownPath = `${ref}.md`;
  if (byPath.has(markdownPath)) return markdownPath;

  return (
    aliases.get(normalizeKey(ref)) ||
    aliases.get(normalizeKey(slugify(ref))) ||
    null
  );
}

export function deriveLevels(
  V: Map<string, GraphVertex>,
  parents: Map<string, string | null>,
  children: Map<string, string[]>
): Map<string, number> {
  const levels = new Map<string, number>();
  const roots = getRootPaths(V);
  const queue: Array<[string, number]> = roots.map((path) => [path, 0]);

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
  derivedLevels = new Map()
}: ValidateGraphInput): GraphIssue[] {
  const issues: GraphIssue[] = [];

  issues.push(...missingParentIssues);

  for (const issue of findCycles(V, parents)) {
    issues.push(issue);
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

function normalizeVertex(note: GraphNote, path: string, index: number): GraphVertex {
  const title = getTitle(note, path);

  return {
    path,
    id: path,
    index,
    note,
    title,
    level: null,
    derivedLevel: null,
    parentRef: cleanWikiRef(getParentRef(note)),
    aliases: []
  };
}

function getRootPaths(V: Map<string, GraphVertex>): string[] {
  return [...V.values()]
    .filter((vertex) => !cleanWikiRef(vertex.parentRef))
    .map((vertex) => vertex.path);
}

function defaultGetId(note: GraphNote, index: number): string {
  return getPath(note) || `__note_${index}`;
}

function getPath(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const path = value.path || value.id || null;
  return path ? String(path) : null;
}

function getTitle(note: GraphNote | null | undefined, fallbackPath: string): string {
  return String(note && note.title ? note.title : fallbackPath.split("/").pop() || fallbackPath);
}

function getParentRef(note: GraphNote | null | undefined): unknown | null {
  if (!note) return null;
  if (Object.prototype.hasOwnProperty.call(note, "parentRef")) return normalizeParentRef(note.parentRef);
  if (note.frontmatterValues && Object.prototype.hasOwnProperty.call(note.frontmatterValues, "parent")) {
    return normalizeParentRef(note.frontmatterValues.parent);
  }
  if (Object.prototype.hasOwnProperty.call(note, "parent")) return normalizeParentRef(note.parent);
  if (Object.prototype.hasOwnProperty.call(note, "parentPath")) return normalizeParentRef(note.parentPath);
  return null;
}

function normalizeParentRef(value: unknown): unknown | null {
  const ref = String(value ?? "").trim();
  return NULLISH_PARENT_REFS.has(ref.toLowerCase()) ? null : value;
}

function getReferenceRefs(note: GraphNote | null | undefined): GraphReference[] {
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

function parseWikiRefsWithMultiplicity(text: unknown): GraphReference[] {
  const refs: GraphReference[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    const parsed = parseWikiTarget(match[1]);
    if (parsed && parsed.ref) refs.push(parsed as GraphReference);
  }

  return refs;
}

function normalizeRef(ref: unknown): GraphReference | null {
  if (!ref) return null;
  if (typeof ref === "string") {
    const parsed = parseWikiTarget(ref);
    return parsed.ref ? parsed : { ref, label: ref };
  }
  if (!isRecord(ref)) return null;
  if (ref.ref) return { ...ref, ref: String(cleanWikiRef(ref.ref) || ref.ref) };
  if (ref.path || ref.id) {
    const value = String(ref.path || ref.id);
    return { ...ref, ref: value, label: ref.label ? String(ref.label) : value };
  }
  return null;
}

function getAliases(vertex: GraphVertex): string[] {
  const aliases = getNoteAliasKeys(vertex.path, vertex.title) as string[];
  vertex.aliases = aliases;
  return aliases;
}

function addWeightedReference(
  refWeights: Map<string, WeightedReference>,
  refsOut: Map<string, Map<string, number>>,
  refsIn: Map<string, Map<string, number>>,
  from: string,
  to: string,
  ref: GraphReference
): void {
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
  if (!weighted) return;
  weighted.weight += 1;
  weighted.refs.push(ref);
  incrementMap(refsOut.get(from), to);
  incrementMap(refsIn.get(to), from);
}

function incrementMap(map: Map<string, number> | undefined, key: string): void {
  if (!map) return;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---")) return text;
  const endIndex = text.indexOf("\n---", 3);
  return endIndex === -1 ? text : text.slice(endIndex + 4);
}
