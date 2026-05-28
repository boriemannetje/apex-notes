import assert from "node:assert/strict";
import test from "node:test";

import { getClampedPopoverPosition } from "./popoverPositioning.ts";

const bounds = {
  left: 100,
  top: 50,
  right: 700,
  bottom: 550
};

const size = {
  width: 300,
  height: 112
};

test("places a popover below and right of the anchor when there is room", () => {
  assert.deepEqual(getClampedPopoverPosition({ x: 160, y: 120 }, size, bounds), {
    left: 170,
    top: 130,
    maxWidth: 576,
    maxHeight: 476
  });
});

test("flips a popover above the anchor near the bottom edge", () => {
  assert.deepEqual(getClampedPopoverPosition({ x: 160, y: 530 }, size, bounds), {
    left: 170,
    top: 408,
    maxWidth: 576,
    maxHeight: 476
  });
});

test("shifts a popover left of the anchor near the right edge", () => {
  assert.deepEqual(getClampedPopoverPosition({ x: 680, y: 120 }, size, bounds), {
    left: 370,
    top: 130,
    maxWidth: 576,
    maxHeight: 476
  });
});

test("clamps both axes near the bottom right edge", () => {
  assert.deepEqual(getClampedPopoverPosition({ x: 690, y: 540 }, size, bounds), {
    left: 380,
    top: 418,
    maxWidth: 576,
    maxHeight: 476
  });
});

test("keeps position inside available bounds in a small graph pane", () => {
  const smallBounds = {
    left: 0,
    top: 0,
    right: 220,
    bottom: 140
  };

  assert.deepEqual(getClampedPopoverPosition({ x: 210, y: 130 }, { width: 196, height: 104 }, smallBounds), {
    left: 12,
    top: 16,
    maxWidth: 196,
    maxHeight: 116
  });
});
