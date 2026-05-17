import assert from "node:assert/strict";
import test from "node:test";

import { buildGraphLayout } from "./graphLayout.js";

test("lays out a valid hierarchy with deterministic fixed levels", () => {
  const notes = [
    note("root.md", "Root", 0, null),
    note("alpha.md", "Alpha", 1, "[[root]]"),
    note("beta.md", "Beta", 1, "[[root]]"),
    note("alpha-child.md", "Alpha Child", 2, "[[alpha]]")
  ];

  const layout = buildGraphLayout({}, notes, {
    levelGap: 100,
    nodeGap: 80,
    subtreeGap: 80,
    collisionGap: 80
  });

  assert.deepEqual([...layout.keys()], ["root.md", "alpha.md", "alpha-child.md", "beta.md"]);
  assert.equal(layout.get("root.md").y, 0);
  assert.equal(layout.get("alpha.md").y, 100);
  assert.equal(layout.get("beta.md").y, 100);
  assert.equal(layout.get("alpha-child.md").y, 200);
  assert.equal(layout.get("beta.md").x - layout.get("alpha.md").x, 80);
});

test("lays out multiple parentless notes as independent roots", () => {
  const notes = [
    note("alpha.md", "Alpha Root", 0, null),
    note("alpha-child.md", "Alpha Child", 1, "[[alpha]]"),
    note("beta.md", "Beta Root", 0, null),
    { path: "loose.md", title: "Loose Note" }
  ];

  const layout = buildGraphLayout({}, notes, {
    levelGap: 100,
    nodeGap: 80,
    subtreeGap: 80,
    rootGap: 160,
    collisionGap: 80
  });

  assert.deepEqual([...layout.keys()], ["alpha.md", "alpha-child.md", "beta.md", "loose.md"]);
  assert.equal(layout.get("alpha.md").y, 0);
  assert.equal(layout.get("beta.md").y, 0);
  assert.equal(layout.get("loose.md").y, 0);
  assert.equal(layout.get("alpha-child.md").y, 100);
  assert(layout.get("beta.md").x > layout.get("alpha.md").x);
  assert(layout.get("loose.md").x > layout.get("beta.md").x);
});

test("places notes with unresolved parents in a separate deterministic grid", () => {
  const notes = [
    note("root.md", "Root", 0, null),
    note("child.md", "Child", 1, "[[root]]"),
    note("broken.md", "Broken", 3, "[[missing]]"),
    { path: "plain.md", title: "Plain" }
  ];

  const layout = buildGraphLayout({}, notes, {
    levelGap: 100,
    nodeGap: 80,
    collisionGap: 80,
    looseGapX: 80,
    looseGapY: 100,
    looseMarginX: 160,
    looseColumns: 1
  });

  const forestMaxX = Math.max(
    layout.get("plain.md").x,
    layout.get("root.md").x,
    layout.get("child.md").x
  );

  assert(layout.get("broken.md").x > forestMaxX);
  assert.equal(layout.get("plain.md").y, 0);
  assert.equal(layout.get("child.md").y, 100);
});

test("reference relaxation changes x only and keeps hierarchy levels fixed", () => {
  const notes = [
    note("root.md", "Root", 0, null),
    note("left.md", "Left", 1, "[[root]]"),
    note("right.md", "Right", 1, "[[root]]"),
    note("left-leaf.md", "Left Leaf", 2, "[[left]]"),
    note("right-leaf.md", "Right Leaf", 2, "[[right]]")
  ];

  const base = buildGraphLayout({}, notes, {
    levelGap: 100,
    nodeGap: 80,
    subtreeGap: 80,
    collisionGap: 80
  });
  const relaxed = buildGraphLayout(
    {
      referenceEdges: [{ from: "left-leaf.md", to: "right.md" }]
    },
    notes,
    {
      levelGap: 100,
      nodeGap: 80,
      subtreeGap: 80,
      collisionGap: 80,
      referenceRelaxation: true,
      referenceStrength: 0.5,
      referenceIterations: 2
    }
  );

  for (const path of base.keys()) {
    assert.equal(relaxed.get(path).y, base.get(path).y);
  }
  assert(relaxed.get("left-leaf.md").x > base.get("left-leaf.md").x);
});

function note(path, title, level, parent) {
  return {
    path,
    title,
    level,
    parentRef: parent,
    hasLevel: true,
    hasTitle: true,
    hasFrontmatter: true
  };
}
