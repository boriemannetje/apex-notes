type SearchNoteObject = {
  path?: unknown;
  id?: unknown;
  title?: unknown;
  searchText?: unknown;
  body?: unknown;
  content?: unknown;
  text?: unknown;
  markdown?: unknown;
};

type SearchNote = string | SearchNoteObject;
type SearchNoteCollection = Iterable<SearchNote> | SearchNote[];
type SearchFields = Record<string, string>;
type FieldWeights = Record<string, number>;

export interface SearchIndexOptions {
  fieldWeights?: Partial<FieldWeights>;
  k1?: number;
  b?: number;
  includeBody?: boolean;
  includeTrigrams?: boolean;
}

interface ResolvedSearchIndexOptions {
  fieldWeights: FieldWeights;
  k1: number;
  b: number;
  includeBody: boolean;
  includeTrigrams: boolean;
}

export interface SearchQueryOptions {
  limit?: number;
  minScore?: number;
  includeTrigramFallback?: boolean;
  minTrigramScore?: number;
  alwaysIncludeTrigram?: boolean;
  trigramLimit?: number;
}

export interface SearchResult {
  path: string;
  title: string;
  note: SearchNote;
  score: number;
  bm25Score: number;
  trigramScore: number;
  matchedTerms: string[];
  matchedTrigrams: string[];
}

interface SearchDocument {
  id: number;
  path: string;
  title: string;
  note: SearchNote;
  fields: SearchFields;
  length: number;
  termCounts: Map<string, number>;
  trigrams: Set<string>;
}

interface FormatResultOptions {
  limit: number;
  minScore: number;
  matchedTerms?: Map<number, string[]>;
  matchedTrigrams?: Map<number, string[]>;
  scoreKind: "bm25" | "trigram";
}

const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
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
  options: ResolvedSearchIndexOptions;
  documents: SearchDocument[] = [];
  byPath: Map<string, SearchDocument> = new Map();
  inverted: Map<string, Map<number, number>> = new Map();
  trigramIndex: Map<string, Set<number>> = new Map();
  documentFrequency: Map<string, number> = new Map();
  averageLength = 0;

  constructor(notes: SearchNoteCollection | null | undefined = [], options: SearchIndexOptions = {}) {
    this.options = {
      fieldWeights: { ...DEFAULT_FIELD_WEIGHTS, ...(options.fieldWeights || {}) },
      k1: finiteNumber(options.k1, DEFAULT_BM25_K1),
      b: finiteNumber(options.b, DEFAULT_BM25_B),
      includeBody: options.includeBody !== false,
      includeTrigrams: options.includeTrigrams !== false
    };
    this.rebuild(notes);
  }

  rebuild(notes: SearchNoteCollection | null | undefined = []): this {
    this.documents = [];
    this.byPath = new Map();
    this.inverted = new Map();
    this.trigramIndex = new Map();
    this.documentFrequency = new Map();
    this.averageLength = 0;

    const seen = new Set<string>();
    for (const note of normalizeNoteList(notes)) {
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

  addDocument(note: SearchNote): SearchDocument | null {
    const path = getPath(note);
    if (!path || this.byPath.has(path)) return null;

    const fields = getSearchFields(note, this.options);
    const termCounts = new Map<string, number>();
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

    const trigrams = this.options.includeTrigrams
      ? getTrigrams(Object.values(fields).join(" "))
      : new Set<string>();
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
      let postings = this.inverted.get(term);
      if (!postings) {
        postings = new Map<number, number>();
        this.inverted.set(term, postings);
      }
      postings.set(doc.id, count);
      this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
    }

    for (const trigram of trigrams) {
      let docIds = this.trigramIndex.get(trigram);
      if (!docIds) {
        docIds = new Set<number>();
        this.trigramIndex.set(trigram, docIds);
      }
      docIds.add(doc.id);
    }

    return doc;
  }

  search(query: unknown, options: SearchQueryOptions = {}): SearchResult[] {
    const limit = positiveInteger(options.limit, 50);
    const minScore = finiteNumber(options.minScore, 0);
    const includeTrigramFallback = options.includeTrigramFallback !== false;
    const minTrigramScore = finiteNumber(options.minTrigramScore, 0.18);
    const bm25Results = this.bm25Search(query, { limit, minScore });

    if (!includeTrigramFallback || !this.options.includeTrigrams) return bm25Results;
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

  bm25Search(query: unknown, options: SearchQueryOptions = {}): SearchResult[] {
    const queryTerms = [...new Set(tokenizeSearchText(query))];
    if (!queryTerms.length || !this.documents.length) return [];

    const scores = new Map<number, number>();
    const matchedTerms = new Map<number, string[]>();
    for (const term of queryTerms) {
      const postings = this.inverted.get(term);
      if (!postings) continue;
      const idf = this.getIdf(term);
      for (const [docId, tf] of postings) {
        const doc = this.documents[docId];
        const score = idf * bm25TermScore(tf, doc.length, this.averageLength, this.options);
        scores.set(docId, (scores.get(docId) || 0) + score);
        let terms = matchedTerms.get(docId);
        if (!terms) {
          terms = [];
          matchedTerms.set(docId, terms);
        }
        terms.push(term);
      }
    }

    return this.formatResults(scores, {
      limit: positiveInteger(options.limit, 50),
      minScore: finiteNumber(options.minScore, 0),
      matchedTerms,
      scoreKind: "bm25"
    });
  }

  trigramSearch(query: unknown, options: SearchQueryOptions = {}): SearchResult[] {
    if (!this.options.includeTrigrams) return [];

    const queryTrigrams = getTrigrams(normalizeForTrigrams(query));
    if (!queryTrigrams.size || !this.documents.length) return [];

    const overlapCounts = new Map<number, number>();
    const matchedTrigrams = new Map<number, string[]>();
    for (const trigram of queryTrigrams) {
      const docIds = this.trigramIndex.get(trigram);
      if (!docIds) continue;
      for (const docId of docIds) {
        overlapCounts.set(docId, (overlapCounts.get(docId) || 0) + 1);
        let trigrams = matchedTrigrams.get(docId);
        if (!trigrams) {
          trigrams = [];
          matchedTrigrams.set(docId, trigrams);
        }
        trigrams.push(trigram);
      }
    }

    const scores = new Map<number, number>();
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

  getIdf(term: string): number {
    const totalDocs = this.documents.length;
    const docsWithTerm = this.documentFrequency.get(term) || 0;
    return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
  }

  formatResults(scores: Map<number, number>, options: FormatResultOptions): SearchResult[] {
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

export function createSearchIndex(
  notes: SearchNoteCollection | null | undefined = [],
  options: SearchIndexOptions = {}
): SearchIndex {
  return new SearchIndex(notes, options);
}

export function tokenizeSearchText(value: unknown): string[] {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

export function getTrigrams(value: unknown): Set<string> {
  const source = normalizeForTrigrams(value);
  const trigrams = new Set<string>();
  if (source.length < MIN_TRIGRAM_SOURCE_LENGTH) return trigrams;
  for (let index = 0; index <= source.length - MIN_TRIGRAM_SOURCE_LENGTH; index += 1) {
    trigrams.add(source.slice(index, index + MIN_TRIGRAM_SOURCE_LENGTH));
  }
  return trigrams;
}

function normalizeNoteList(notes: SearchNoteCollection | null | undefined): SearchNote[] {
  if (!notes) return [];
  return Array.isArray(notes) ? notes : [...notes];
}

function getSearchFields(note: SearchNote, options: ResolvedSearchIndexOptions): SearchFields {
  const path = getPath(note);
  const fields: SearchFields = {
    title: getTitle(note, path),
    path
  };

  if (options.includeBody) {
    fields.searchText = isSearchNoteObject(note) && note.searchText ? String(note.searchText) : "";
    fields.body = String(
      (isSearchNoteObject(note) && (note.body || note.content || note.text || note.markdown)) ||
      ""
    );
  }

  return fields;
}

function bm25TermScore(
  tf: number,
  docLength: number,
  averageLength: number,
  options: ResolvedSearchIndexOptions
): number {
  const k1 = finiteNumber(options.k1, DEFAULT_BM25_K1);
  const b = finiteNumber(options.b, DEFAULT_BM25_B);
  const normalizedLength = averageLength > 0 ? docLength / averageLength : 1;
  return (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * normalizedLength));
}

function getPath(note: SearchNote | null | undefined): string {
  if (!note) return "";
  if (typeof note === "string") return note;
  return String(note.path || note.id || "");
}

function getTitle(note: SearchNote | null | undefined, fallbackPath: string): string {
  if (isSearchNoteObject(note) && note.title) return String(note.title);
  return String(fallbackPath || "").split("/").pop() || String(fallbackPath || "");
}

function isSearchNoteObject(note: SearchNote | null | undefined): note is SearchNoteObject {
  return Boolean(note && typeof note === "object");
}

function normalizeSearchText(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeForTrigrams(value: unknown): string {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compareSearchResults(a: SearchResult, b: SearchResult): number {
  return (
    b.score - a.score ||
    b.bm25Score - a.bm25Score ||
    b.trigramScore - a.trigramScore ||
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" }) ||
    String(a.path).localeCompare(String(b.path), undefined, { sensitivity: "base" })
  );
}
