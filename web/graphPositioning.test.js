import assert from "node:assert/strict";
import test from "node:test";

import {
  createAbsolutePositionPatch,
  findChildPosition,
  findLooseGridPositions,
  resolveStoredPosition,
  resolveStoredPositions
} from "./graphPositioning.js";

test("resolves legacy dx dy positions against auto positions", () => {
  const autoPositions = new Map([
    ["root.md", { x: 120, y: 40 }],
    ["child.md", { x: 200, y: 140 }]
  ]);

  assert.deepEqual(resolveStoredPosition("child.md", { dx: -16, dy: 24 }, autoPositions), {
    x: 184,
    y: 164
  });
  assert.deepEqual(resolveStoredPositions({ "root.md": { dx: 10 } }, autoPositions), {
    "root.md": { x: 130, y: 40 }
  });
});

test("absolute stored positions pass through as absolute coordinates", () => {
  assert.deepEqual(resolveStoredPosition("root.md", { x: 14.4444, y: 20.5555 }, new Map()), {
    x: 14.444,
    y: 20.556
  });
});

test("creates absolute position patches from current positions", () => {
  const positions = new Map([
    ["root.md", { x: 100.3333, y: 25.6666 }],
    ["child.md", { x: 150, y: 125 }]
  ]);

  assert.deepEqual(createAbsolutePositionPatch(["root.md", "missing.md"], positions, { precision: 2 }), {
    "root.md": { x: 100.33, y: 25.67 }
  });
});

test("parented new note lands below parent and avoids occupied slots", () => {
  const positions = new Map([
    ["parent.md", { x: 100, y: 50 }],
    ["occupied.md", { x: 100, y: 150 }],
    ["right.md", { x: 180, y: 150 }]
  ]);

  assert.deepEqual(findChildPosition("parent.md", positions, { levelGap: 100, collisionGap: 80 }), {
    x: 20,
    y: 150
  });
});

test("parentless new notes form a grid to the right of current graph bounds", () => {
  const positions = new Map([
    ["root.md", { x: 100, y: 20 }],
    ["child.md", { x: 220, y: 120 }]
  ]);

  assert.deepEqual(
    findLooseGridPositions(["loose-a.md", "loose-b.md", "loose-c.md"], positions, {
      looseColumns: 2,
      looseGapX: 50,
      looseGapY: 75,
      looseMarginX: 200
    }),
    {
      "loose-a.md": { x: 420, y: 20 },
      "loose-b.md": { x: 470, y: 20 },
      "loose-c.md": { x: 420, y: 95 }
    }
  );
});
