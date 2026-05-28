// @ts-nocheck
const DEFAULT_RESULT_LIMIT = 12;

export function buildSearchResults(notes = [], searchIndex = null, query = "", options = {}) {
  const limit = positiveInteger(options.limit, DEFAULT_RESULT_LIMIT);
  const noteList = normalizeNotes(notes);
  const normalizedQuery = normalizeSearchText(query).trim();

  if (!normalizedQuery) {
    return noteList
      .sort(compareBrowseResults)
      .slice(0, limit)
      .map((note) => formatResult(note, 0));
  }

  const tokens = tokenizeQuery(normalizedQuery);
  const results = new Map();
  const addResult = (note, score) => {
    if (!note || !note.path || score <= 0) return;
    const existing = results.get(note.path);
    if (!existing || score > existing.score) {
      results.set(note.path, formatResult(note, score));
    }
  };

  if (searchIndex && typeof searchIndex.search === "function") {
    const indexResults = searchIndex.search(normalizedQuery, {
      limit: Math.max(limit * 4, noteList.length),
      minScore: 0,
      includeTrigramFallback: true,
      alwaysIncludeTrigram: true,
      minTrigramScore: 0.12
    });

    for (const result of indexResults) {
      addResult(result.note, indexScore(result));
    }
  }

  for (const note of noteList) {
    addResult(note, scoreNote(note, normalizedQuery, tokens));
  }

  return [...results.values()]
    .sort(compareRankedResults)
    .slice(0, limit);
}

function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : [...notes || []])
    .map((note) => {
      const path = String(note && note.path ? note.path : "");
      if (!path) return null;
      return {
        note,
        path,
        title: String(note.title || path.split("/").pop() || path),
        searchText: String(note.searchText || `${note.title || ""} ${path} ${note.body || ""}`)
      };
    })
    .filter(Boolean);
}

function formatResult(item, score) {
  return {
    note: item.note || item,
    path: item.path,
    title: item.title,
    score
  };
}

function scoreNote(item, query, tokens) {
  const title = normalizeSearchText(item.title);
  const path = normalizeSearchText(item.path);
  const fileName = normalizeSearchText(item.path.split("/").pop() || item.path);
  const searchText = normalizeSearchText(item.searchText);
  const compactQuery = compact(query);

  let score = 0;
  score += scoreField(title, query, tokens, 120);
  score += scoreField(fileName, query, tokens, 86);
  score += scoreField(path, query, tokens, 58);
  score += scoreField(searchText, query, tokens, 24);

  if (compactQuery) {
    if (compact(title) === compactQuery) score += 26;
    if (compact(fileName).startsWith(compactQuery)) score += 14;
  }

  return score;
}

function scoreField(value, query, tokens, weight) {
  if (!value || !query) return 0;

  if (value === query) return weight;
  if (value.startsWith(query)) return weight * 0.86;

  const index = value.indexOf(query);
  if (index >= 0) {
    const positionBoost = Math.max(0, 1 - index / Math.max(value.length, 1));
    return weight * (0.58 + positionBoost * 0.16);
  }

  if (tokens.length && tokens.every((token) => value.includes(token))) {
    const firstIndex = Math.min(...tokens.map((token) => value.indexOf(token)).filter((item) => item >= 0));
    const positionBoost = Math.max(0, 1 - firstIndex / Math.max(value.length, 1));
    return weight * (0.34 + positionBoost * 0.12);
  }

  const fuzzyScore = subsequenceScore(value, query);
  return fuzzyScore > 0 ? weight * fuzzyScore * 0.22 : 0;
}

function indexScore(result) {
  const score = Number(result && result.score) || 0;
  const bm25 = Number(result && result.bm25Score) || 0;
  const trigram = Number(result && result.trigramScore) || 0;
  return score * 12 + bm25 * 4 + trigram * 18;
}

function subsequenceScore(value, query) {
  if (!value || !query || query.length < 2) return 0;
  let position = 0;
  let firstMatch = -1;
  for (const char of query) {
    const next = value.indexOf(char, position);
    if (next < 0) return 0;
    if (firstMatch < 0) firstMatch = next;
    position = next + 1;
  }

  const spread = Math.max(1, position - firstMatch);
  const tightness = query.length / spread;
  const startBoost = Math.max(0, 1 - firstMatch / Math.max(value.length, 1));
  return Math.min(1, tightness * 0.75 + startBoost * 0.25);
}

function tokenizeQuery(value) {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function compact(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, "");
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compareBrowseResults(a, b) {
  return (
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }) ||
    String(a.path).localeCompare(String(b.path), undefined, { sensitivity: "base" })
  );
}

function compareRankedResults(a, b) {
  return (
    b.score - a.score ||
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }) ||
    String(a.path).localeCompare(String(b.path), undefined, { sensitivity: "base" })
  );
}
