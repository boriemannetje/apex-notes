const DEFAULT_FIELD_WEIGHTS = {
  title: 3,
  path: 1.4,
  body: 1,
  searchText: 1
};

const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;
const MIN_TOKEN_LENGTH = 2;
const MIN_TRIGRAM_SOURCE_LENGTH = 3;

export class SearchIndex {
  constructor(notes = [], options = {}) {
    this.options = {
      fieldWeights: { ...DEFAULT_FIELD_WEIGHTS, ...(options.fieldWeights || {}) },
      k1: finiteNumber(options.k1, DEFAULT_BM25_K1),
      b: finiteNumber(options.b, DEFAULT_BM25_B),
      includeBody: options.includeBody !== false
    };
    this.rebuild(notes);
  }

  rebuild(notes = []) {
    this.documents = [];
    this.byPath = new Map();
    this.inverted = new Map();
    this.trigramIndex = new Map();
    this.documentFrequency = new Map();
    this.averageLength = 0;

    const seen = new Set();
    for (const note of Array.isArray(notes) ? notes : [...notes || []]) {
      const path = getPath(note);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      this.addDocument(note);
    }

    this.averageLength = this.documents.length
      ? this.documents.reduce((sum, doc) => sum + doc.length, 0) / this.documents.length
      : 0;

    return this;
  }

  addDocument(note) {
    const path = getPath(note);
    if (!path || this.byPath.has(path)) return null;

    const fields = getSearchFields(note, this.options);
    const termCounts = new Map();
    let length = 0;

    for (const [field, value] of Object.entries(fields)) {
      const weight = finiteNumber(this.options.fieldWeights[field], 1);
      if (weight <= 0) continue;
      const tokens = tokenizeSearchText(value);
      length += tokens.length;
      for (const token of tokens) {
        termCounts.set(token, (termCounts.get(token) || 0) + weight);
      }
    }

    const trigramSource = normalizeForTrigrams(Object.values(fields).join(" "));
    const trigrams = getTrigrams(trigramSource);
    const doc = {
      id: this.documents.length,
      path,
      title: getTitle(note, path),
      note,
      fields,
      length: Math.max(1, length),
      termCounts,
      trigrams
    };

    this.documents.push(doc);
    this.byPath.set(path, doc);

    for (const [term, count] of termCounts) {
      if (!this.inverted.has(term)) this.inverted.set(term, new Map());
      this.inverted.get(term).set(doc.id, count);
      this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
    }

    for (const trigram of trigrams) {
      if (!this.trigramIndex.has(trigram)) this.trigramIndex.set(trigram, new Set());
      this.trigramIndex.get(trigram).add(doc.id);
    }

    return doc;
  }

  search(query, options = {}) {
    const limit = positiveInteger(options.limit, 50);
    const minScore = finiteNumber(options.minScore, 0);
    const includeTrigramFallback = options.includeTrigramFallback !== false;
    const minTrigramScore = finiteNumber(options.minTrigramScore, 0.18);
    const bm25Results = this.bm25Search(query, { limit, minScore });

    if (!includeTrigramFallback) return bm25Results;
    if (bm25Results.length >= limit && !options.alwaysIncludeTrigram) return bm25Results;

    const merged = new Map(bm25Results.map((result) => [result.path, result]));
    const fallbackLimit = Math.max(limit, positiveInteger(options.trigramLimit, limit));
    const trigramResults = this.trigramSearch(query, {
      limit: fallbackLimit,
      minScore: minTrigramScore
    });

    for (const result of trigramResults) {
      const existing = merged.get(result.path);
      if (existing) {
        existing.trigramScore = Math.max(existing.trigramScore || 0, result.trigramScore);
        existing.score += result.trigramScore * 0.35;
        existing.matchedTrigrams = result.matchedTrigrams;
      } else {
        merged.set(result.path, {
          ...result,
          score: result.trigramScore * 0.35,
          bm25Score: 0
        });
      }
    }

    return [...merged.values()]
      .filter((result) => result.score >= minScore)
      .sort(compareSearchResults)
      .slice(0, limit);
  }

  bm25Search(query, options = {}) {
    const queryTerms = [...new Set(tokenizeSearchText(query))];
    if (!queryTerms.length || !this.documents.length) return [];

    const scores = new Map();
    const matchedTerms = new Map();
    for (const term of queryTerms) {
      const postings = this.inverted.get(term);
      if (!postings) continue;
      const idf = this.getIdf(term);
      for (const [docId, tf] of postings) {
        const doc = this.documents[docId];
        const score = idf * bm25TermScore(tf, doc.length, this.averageLength, this.options);
        scores.set(docId, (scores.get(docId) || 0) + score);
        if (!matchedTerms.has(docId)) matchedTerms.set(docId, []);
        matchedTerms.get(docId).push(term);
      }
    }

    return this.formatResults(scores, {
      limit: positiveInteger(options.limit, 50),
      minScore: finiteNumber(options.minScore, 0),
      matchedTerms,
      scoreKind: "bm25"
    });
  }

  trigramSearch(query, options = {}) {
    const queryTrigrams = getTrigrams(normalizeForTrigrams(query));
    if (!queryTrigrams.size || !this.documents.length) return [];

    const overlapCounts = new Map();
    const matchedTrigrams = new Map();
    for (const trigram of queryTrigrams) {
      const docIds = this.trigramIndex.get(trigram);
      if (!docIds) continue;
      for (const docId of docIds) {
        overlapCounts.set(docId, (overlapCounts.get(docId) || 0) + 1);
        if (!matchedTrigrams.has(docId)) matchedTrigrams.set(docId, []);
        matchedTrigrams.get(docId).push(trigram);
      }
    }

    const scores = new Map();
    for (const [docId, overlap] of overlapCounts) {
      const doc = this.documents[docId];
      const union = queryTrigrams.size + doc.trigrams.size - overlap;
      const score = union > 0 ? overlap / union : 0;
      scores.set(docId, score);
    }

    return this.formatResults(scores, {
      limit: positiveInteger(options.limit, 50),
      minScore: finiteNumber(options.minScore, 0.18),
      matchedTrigrams,
      scoreKind: "trigram"
    });
  }

  getIdf(term) {
    const totalDocs = this.documents.length;
    const docsWithTerm = this.documentFrequency.get(term) || 0;
    return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
  }

  formatResults(scores, options) {
    return [...scores.entries()]
      .map(([docId, score]) => {
        const doc = this.documents[docId];
        return {
          path: doc.path,
          title: doc.title,
          note: doc.note,
          score,
          bm25Score: options.scoreKind === "bm25" ? score : 0,
          trigramScore: options.scoreKind === "trigram" ? score : 0,
          matchedTerms: options.matchedTerms ? options.matchedTerms.get(docId) || [] : [],
          matchedTrigrams: options.matchedTrigrams ? options.matchedTrigrams.get(docId) || [] : []
        };
      })
      .filter((result) => result.score >= options.minScore)
      .sort(compareSearchResults)
      .slice(0, options.limit);
  }
}

export function createSearchIndex(notes = [], options = {}) {
  return new SearchIndex(notes, options);
}

export function searchNotes(notes = [], query = "", options = {}) {
  return createSearchIndex(notes, options.indexOptions || options).search(query, options);
}

export function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

export function getTrigrams(value) {
  const source = normalizeForTrigrams(value);
  const trigrams = new Set();
  if (source.length < MIN_TRIGRAM_SOURCE_LENGTH) return trigrams;
  for (let index = 0; index <= source.length - MIN_TRIGRAM_SOURCE_LENGTH; index += 1) {
    trigrams.add(source.slice(index, index + MIN_TRIGRAM_SOURCE_LENGTH));
  }
  return trigrams;
}

function getSearchFields(note, options) {
  const path = getPath(note);
  const fields = {
    title: getTitle(note, path),
    path,
    searchText: note && note.searchText ? String(note.searchText) : ""
  };

  if (options.includeBody) {
    fields.body = String(
      (note && (note.body || note.content || note.text || note.markdown)) ||
      ""
    );
  }

  return fields;
}

function bm25TermScore(tf, docLength, averageLength, options) {
  const k1 = finiteNumber(options.k1, DEFAULT_BM25_K1);
  const b = finiteNumber(options.b, DEFAULT_BM25_B);
  const normalizedLength = averageLength > 0 ? docLength / averageLength : 1;
  return (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * normalizedLength));
}

function getPath(note) {
  if (!note) return "";
  if (typeof note === "string") return note;
  return String(note.path || note.id || "");
}

function getTitle(note, fallbackPath) {
  if (note && note.title) return String(note.title);
  return String(fallbackPath || "").split("/").pop() || String(fallbackPath || "");
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeForTrigrams(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compareSearchResults(a, b) {
  return (
    b.score - a.score ||
    b.bm25Score - a.bm25Score ||
    b.trigramScore - a.trigramScore ||
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }) ||
    String(a.path).localeCompare(String(b.path), undefined, { sensitivity: "base" })
  );
}
