import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_SIZE_MAX_SCALE,
  connectionCountToNodeScale
} from "./nodeSizing.js";

test("connection scale starts at the current node size", () => {
  assert.equal(connectionCountToNodeScale(0), 1);
  assert.equal(connectionCountToNodeScale(-4), 1);
  assert.equal(connectionCountToNodeScale(Number.NaN), 1);
});

test("connection scale grows linearly to 2.8x at 20 connections", () => {
  assert.equal(connectionCountToNodeScale(10), 1.9);
  assert.equal(connectionCountToNodeScale(20), 2.8);
});

test("connection scale approaches but never reaches 3x after 20 connections", () => {
  const atTwentyOne = connectionCountToNodeScale(21);
  const atForty = connectionCountToNodeScale(40);
  const atHundred = connectionCountToNodeScale(100);

  assert(atTwentyOne > 2.8);
  assert(atForty > atTwentyOne);
  assert(atHundred > atForty);
  assert(atHundred < NODE_SIZE_MAX_SCALE);
});
