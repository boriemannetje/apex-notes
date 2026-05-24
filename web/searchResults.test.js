import assert from "node:assert/strict";
import test from "node:test";

import { SearchIndex } from "./searchIndex.js";
import { buildSearchResults } from "./searchResults.js";

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

function note(path, title, body) {
  return {
    path,
    title,
    body,
    searchText: `${title} ${path} ${body}`
  };
}
