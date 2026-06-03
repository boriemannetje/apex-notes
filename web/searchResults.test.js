import assert from "node:assert/strict";
import test from "node:test";

import { SearchIndex } from "./searchIndex.ts";
import { buildSearchResults } from "./searchResults.ts";

test("ranked search puts the closest title match first", () => {
  const notes = [
    note("search-overlay.md", "Search Overlay", "graph dropdown result list"),
    note("graph-layout.md", "Graph Layout Stability", "search behavior mentions graph"),
    note("release-checklist.md", "Release Checklist", "graph graph graph")
  ];
  const results = buildSearchResults(notes, new SearchIndex(notes), "graph layout");

  assert.equal(results[0].path, "graph-layout.md");
});

test("ranked search supports short prefix queries", () => {
  const notes = [
    note("search-overlay.md", "Search Overlay", ""),
    note("selection.md", "Selection Model", ""),
    note("layout.md", "Graph Layout", "")
  ];
  const results = buildSearchResults(notes, new SearchIndex(notes), "se");

  assert.deepEqual(results.slice(0, 2).map((result) => result.path), [
    "search-overlay.md",
    "selection.md"
  ]);
});

test("empty search browses notes alphabetically", () => {
  const notes = [
    note("zeta.md", "Zeta", ""),
    note("alpha.md", "Alpha", ""),
    note("middle.md", "Middle", "")
  ];
  const results = buildSearchResults(notes, new SearchIndex(notes), "");

  assert.deepEqual(results.map((result) => result.path), [
    "alpha.md",
    "middle.md",
    "zeta.md"
  ]);
});

test("search index defaults include body content", () => {
  const notes = [
    note("alpha.md", "Alpha", "quiet body with citrine marker"),
    note("beta.md", "Beta", "ordinary body text")
  ];
  const results = new SearchIndex(notes).search("citrine", {
    includeTrigramFallback: false
  });

  assert.equal(results[0].path, "alpha.md");
});

test("search index can skip body-derived fields", () => {
  const notes = [
    note("alpha.md", "Alpha", "quiet body with jasper marker")
  ];
  const index = new SearchIndex(notes, { includeBody: false });
  const doc = index.byPath.get("alpha.md");

  assert.equal(doc.fields.body, undefined);
  assert.equal(doc.fields.searchText, undefined);
  assert.deepEqual(index.search("jasper", { includeTrigramFallback: false }), []);
  assert.equal(index.search("alpha", { includeTrigramFallback: false })[0].path, "alpha.md");
});

test("ranked search respects title-path-only reduced mode", () => {
  const notes = [
    note("alpha.md", "Alpha", "quiet body with amber marker")
  ];
  const index = new SearchIndex(notes, { includeBody: false });

  assert.deepEqual(
    buildSearchResults(notes, index, "amber", { includeBody: false }),
    []
  );
  assert.equal(
    buildSearchResults(notes, index, "alpha", { includeBody: false })[0].path,
    "alpha.md"
  );
});

test("search index can skip trigram indexing", () => {
  const notes = [
    note("alpha.md", "Alpha", "quiet body with topaz marker")
  ];
  const index = new SearchIndex(notes, { includeTrigrams: false });
  const doc = index.byPath.get("alpha.md");

  assert.equal(index.trigramIndex.size, 0);
  assert.equal(doc.trigrams.size, 0);
  assert.deepEqual(index.trigramSearch("topaz"), []);
  assert.equal(index.search("topaz")[0].path, "alpha.md");
});

function note(path, title, body) {
  return {
    path,
    title,
    body,
    searchText: `${title} ${path} ${body}`
  };
}
