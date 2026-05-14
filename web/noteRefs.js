export function parseWikiRefs(text) {
  const refs = [];
  const seen = new Set();
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    const parsed = parseWikiTarget(match[1]);
    if (!parsed.ref) continue;
    const key = normalizeKey(parsed.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(parsed);
  }

  return refs;
}

export function parseWikiTarget(value) {
  const raw = unwrapWikiSyntax(value);
  const parts = raw.split("|");
  const ref = cleanReference(parts[0]);
  const alias = parts.slice(1).join("|").trim();

  return {
    ref,
    label: alias || ref.split("/").pop() || ref
  };
}

export function cleanWikiRef(value) {
  const ref = parseWikiTarget(value).ref;
  return ref && ref !== "null" ? ref : null;
}

export function getNoteAliasKeys(path, title) {
  const pathNoExt = String(path || "").replace(/\.md$/i, "");
  const basename = pathNoExt.split("/").pop() || pathNoExt;

  return [
    path,
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

export function normalizeKey(value) {
  return String(value || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase();
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function unwrapWikiSyntax(value) {
  const raw = referenceString(value);
  const wiki = raw.match(/^\s*\[\[([^\]]+)\]\]\s*$/) || raw.match(/\[\[([^\]]+)\]\]/);
  return wiki ? wiki[1] : raw;
}

function cleanReference(value) {
  return String(value || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .trim();
}

function referenceString(value) {
  if (!value || value === "null") return "";
  if (typeof value === "string") return value;
  if (typeof value.path === "string") return value.path;
  if (typeof value.id === "string") return value.id;
  return String(value);
}
