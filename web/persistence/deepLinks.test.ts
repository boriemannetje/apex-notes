import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceDeepLink } from "./deepLinks.ts";

test("parses credential-free open and configured sync requests", () => {
  assert.deepEqual(parseWorkspaceDeepLink("apex-notes://open?path=%2FUsers%2Fperson%2FMy%20Notes"), { action: "open", rootPath: "/Users/person/My Notes" });
  assert.deepEqual(parseWorkspaceDeepLink("apex-notes://sync?connection=healthy-habits"), { action: "sync", connectionId: "healthy-habits" });
});

test("rejects ambiguous URLs, authority overrides, credentials, and unsafe paths", () => {
  for (const url of [
    "https://sync?connection=diary", "apex-notes://sync/extra?connection=diary", "apex-notes://sync/?connection=diary",
    "apex-notes://user:secret@sync?connection=diary", "apex-notes://sync:123?connection=diary",
    "apex-notes://sync?connection=diary&token=secret", "apex-notes://sync?connection=a&connection=b",
    "apex-notes://sync?connection=diary#secret", "apex-notes://sync?connection=diary#",
    "apex-notes://sync?connection=../diary", "apex-notes://open?path=relative", "apex-notes://open?path=/",
    "apex-notes://open?path=%2Ftmp%2F..%2Fsecret", "apex-notes://open?path=%2Ftmp%2F.%2Fsecret",
    "apex-notes://open?path=%2F%2Fserver%2Fshare", "apex-notes://open?path=%2Ftmp%5Csecret",
    "apex-notes://open?path=%2Ftmp%00x", "apex-notes://open?path=%2Ftmp%ZZ", "apex-notes://open?path=%2Ftmp%FF",
    "apex-notes://open?path=/tmp/My Notes", "apex-notes://delete?path=/tmp/notes"
  ]) assert.throws(() => parseWorkspaceDeepLink(url), undefined, url);
});
