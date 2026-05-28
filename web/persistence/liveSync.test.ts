import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFileSignatureMap,
  cloneFileSignatures,
  diffFileSignatures,
  fileSignature,
  liveUpdateStatus
} from "./liveSync.ts";

test("fileSignature prefers native signatures and falls back to modified time plus bytes", () => {
  assert.equal(fileSignature({ signature: "abc", modifiedMs: 1, byteLen: 2 }), "abc");
  assert.equal(fileSignature({ modifiedMs: 12, byteLen: 34 }), "12:34");
  assert.equal(fileSignature(null), "0:0");
});

test("buildFileSignatureMap ignores malformed status rows", () => {
  assert.deepEqual(
    [...buildFileSignatureMap([{ path: "a.md", signature: "a" }, {}, { path: "b.md", modifiedMs: 1, byteLen: 2 }])],
    [
      ["a.md", "a"],
      ["b.md", "1:2"]
    ]
  );
});

test("cloneFileSignatures accepts Map, plain object, and empty values", () => {
  assert.deepEqual([...cloneFileSignatures(new Map([["a.md", "1"]]))], [["a.md", "1"]]);
  assert.deepEqual([...cloneFileSignatures({ "b.md": "2" })], [["b.md", "2"]]);
  assert.deepEqual([...cloneFileSignatures(null)], []);
});

test("diffFileSignatures reports added, changed, deleted, and next signatures", () => {
  const diff = diffFileSignatures(
    new Map([
      ["same.md", "same"],
      ["changed.md", "old"],
      ["deleted.md", "gone"]
    ]),
    [
      { path: "same.md", signature: "same" },
      { path: "changed.md", signature: "new" },
      { path: "added.md", signature: "fresh" }
    ]
  );

  assert.deepEqual(diff.pathsToRead, ["changed.md", "added.md"]);
  assert.deepEqual(diff.deletedPaths, ["deleted.md"]);
  assert.deepEqual([...diff.nextSignatures], [
    ["same.md", "same"],
    ["changed.md", "new"],
    ["added.md", "fresh"]
  ]);
});

test("liveUpdateStatus builds the compact editor status string", () => {
  assert.equal(liveUpdateStatus(1, 2, 3), "Live updated: 1 added, 2 changed, 3 removed");
  assert.equal(liveUpdateStatus(0, 1, 0), "Live updated: 1 changed");
});
