export const RECENT_PROJECTS_STORAGE_KEY = "apex-notes-recent-projects-v1";
export const RECENT_PROJECT_LIMIT = 8;

export function loadRecentProjects(storage = getDefaultStorage()) {
  if (!storage) return [];

  try {
    const raw = storage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return normalizeRecentProjects(parsed);
  } catch {
    return [];
  }
}

export function saveRecentProjects(projects, storage = getDefaultStorage()) {
  if (!storage) return;

  try {
    storage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(normalizeRecentProjects(projects))
    );
  } catch {
    // Private browsing or quota issues should not block folder opening.
  }
}

export function rememberRecentProject(project, projects = [], now = Date.now()) {
  const normalized = normalizeRecentProject({
    ...project,
    lastOpenedAt: now
  });
  if (!normalized) return normalizeRecentProjects(projects);

  const next = [
    normalized,
    ...normalizeRecentProjects(projects).filter((item) => item.rootPath !== normalized.rootPath)
  ];
  return next.slice(0, RECENT_PROJECT_LIMIT);
}

export function removeRecentProject(rootPath, projects = []) {
  return normalizeRecentProjects(projects).filter((item) => item.rootPath !== rootPath);
}

export function projectNameFromPath(rootPath) {
  const parts = splitPath(rootPath);
  return parts[parts.length - 1] || "Folder";
}

export function projectLocationFromPath(rootPath) {
  const normalized = normalizePath(rootPath);
  if (!normalized) return "";

  const separator = normalized.includes("\\") ? "\\" : "/";
  const parts = splitPath(normalized);
  if (parts.length <= 1) return separator === "\\" ? "" : "/";

  const parent = normalized.slice(0, normalized.lastIndexOf(separator)) || separator;
  const homeMatch = parent.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (homeMatch) {
    return homeMatch[1] ? `~${homeMatch[1]}` : "~";
  }

  return parent;
}

export function normalizeRecentProjects(projects) {
  const deduped = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    const normalized = normalizeRecentProject(project);
    if (!normalized || deduped.has(normalized.rootPath)) continue;
    deduped.set(normalized.rootPath, normalized);
  }

  return [...deduped.values()]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, RECENT_PROJECT_LIMIT);
}

function normalizeRecentProject(project) {
  const rootPath = normalizePath(project?.rootPath);
  if (!rootPath) return null;

  const name = String(project?.name || projectNameFromPath(rootPath)).trim() || "Folder";
  const lastOpenedAt = Number.isFinite(Number(project?.lastOpenedAt))
    ? Number(project.lastOpenedAt)
    : 0;

  return {
    rootPath,
    name,
    lastOpenedAt
  };
}

function normalizePath(path) {
  const trimmed = String(path || "").trim();
  if (/^[\\/]+$/.test(trimmed)) return trimmed[0];
  return trimmed.replace(/[\\/]+$/, "");
}

function splitPath(path) {
  return normalizePath(path).split(/[\\/]+/).filter(Boolean);
}

function getDefaultStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
