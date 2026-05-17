import assert from "node:assert/strict";
import test from "node:test";

import { createGraphIndex, ISSUE_TYPES } from "./graphModel.js";

test("builds explicit vertices, tree edges, and weighted reference edges", () => {
  const index = createGraphIndex([
    note("root.md", "Root", 0, null, "[[leaf]] [[leaf]]"),
    note("branch.md", "Branch", 1, "[[root]]", "[[leaf]] [[leaf|again]]"),
    note("leaf.md", "Leaf", 2, "[[branch]]", "")
  ]);

  assert.equal(index.V.size, 3);
  assert.deepEqual(
    index.E_tree.map((edge) => [edge.from, edge.to]),
    [
      ["root.md", "branch.md"],
      ["branch.md", "leaf.md"]
    ]
  );
  assert.deepEqual(
    index.E_ref.map((edge) => [edge.from, edge.to, edge.weight]),
    [["root.md", "leaf.md", 2]]
  );
  assert.equal(index.parents.get("branch.md"), "root.md");
  assert.deepEqual(index.children.get("branch.md"), ["leaf.md"]);
  assert.equal(index.refsOut.get("root.md").get("leaf.md"), 2);
  assert.equal(index.refsIn.get("leaf.md").get("root.md"), 2);
});

test("resolves parent refs through note aliases and derives missing levels", () => {
  const index = createGraphIndex([
    note("folder/root-note.md", "Guiding Principle", 0, null, ""),
    { path: "child.md", title: "Child", parentRef: "[[root-note]]", body: "" }
  ]);

  assert.equal(index.parents.get("child.md"), "folder/root-note.md");
  assert.equal(index.V.get("child.md").declaredLevel, null);
  assert.equal(index.V.get("child.md").derivedLevel, 1);
  assert.equal(index.V.get("child.md").level, 1);
});

test("keeps broken notes present and reports invariant violations", () => {
  const index = createGraphIndex([
    note("root.md", "Root", 0, null, ""),
    note("broken.md", "Broken", 3, "[[missing]]", ""),
    note("too-deep.md", "Too Deep", 9, "[[root]]", "")
  ]);

  assert(index.V.has("broken.md"));
  assert.equal(index.parents.get("broken.md"), null);
  assert.deepEqual(index.roots, ["root.md"]);
  assert.deepEqual(
    index.validation.map((issue) => issue.type).sort(),
    [ISSUE_TYPES.LEVEL_MISMATCH, ISSUE_TYPES.MISSING_PARENT].sort()
  );
});

test("supports multiple parentless roots and loose notes as valid forest entries", () => {
  const index = createGraphIndex([
    note("alpha.md", "Alpha Root", 0, null, "[[orphan]]"),
    note("beta.md", "Beta Root", 0, null, ""),
    { path: "loose.md", title: "Loose Note", parentRef: null, body: "[[alpha]]" },
    note("alpha-child.md", "Alpha Child", 1, "[[alpha]]", "")
  ]);

  assert.deepEqual(index.roots, ["alpha.md", "beta.md", "loose.md"]);
  assert.equal(index.parents.get("alpha-child.md"), "alpha.md");
  assert.deepEqual(index.children.get("alpha.md"), ["alpha-child.md"]);
  assert.equal(index.V.get("loose.md").derivedLevel, 0);
  assert.equal(index.V.get("loose.md").level, 0);
  assert(!index.validation.some((issue) => issue.type === ISSUE_TYPES.ROOT_COUNT));
  assert(!index.validation.some((issue) => issue.type === ISSUE_TYPES.DISCONNECTED));
});

test("reports duplicate aliases and cycles without throwing away vertices", () => {
  const index = createGraphIndex([
    note("a.md", "Same", 0, "[[b]]", ""),
    note("b.md", "Same", 1, "[[a]]", "")
  ]);

  assert.equal(index.V.size, 2);
  assert.deepEqual(index.duplicateAliases.get("same"), ["a.md", "b.md"]);
  assert(index.validation.some((issue) => issue.type === ISSUE_TYPES.CYCLE));
  assert(!index.validation.some((issue) => issue.type === ISSUE_TYPES.ROOT_COUNT));
});

function note(path, title, level, parentRef, body) {
  return {
    path,
    title,
    level,
    parentRef,
    body,
    hasLevel: true,
    hasTitle: true,
    hasFrontmatter: true
  };
}
