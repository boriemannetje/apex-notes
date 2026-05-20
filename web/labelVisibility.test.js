import assert from "node:assert/strict";
import test from "node:test";

import { computeNoteLinkStats } from "./labelVisibility.js";

test("link stats count unique hierarchy and contextual neighbors", () => {
  const stats = computeNoteLinkStats([
    note("root.md", "Root", 0, null, "[[branch]] [[leaf]] [[leaf]]"),
    note("branch.md", "Branch", 1, "[[root]]", "[[leaf]] [[leaf]]"),
    note("leaf.md", "Leaf", 2, "[[branch]]", "[[root]]")
  ]);

  assert.equal(stats.get("root.md").uniqueNeighborCount, 2);
  assert.equal(stats.get("branch.md").uniqueNeighborCount, 2);
  assert.equal(stats.get("leaf.md").uniqueNeighborCount, 2);
});

function note(path, title, level, parentRef, body) {
  return {
    path,
    title,
    level,
    parentRef,
    body
  };
}
