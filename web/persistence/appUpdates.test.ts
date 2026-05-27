import test from "node:test";
import assert from "node:assert/strict";
import {
  MAIN_PRODUCTION_DMG_DOWNLOAD_URL,
  MAIN_PRODUCTION_DMG_ASSET,
  checkForAppUpdate,
  findReleaseAsset,
  getUpdateAvailability,
  isMainProductionDownloadUrl,
  normalizeCommit,
  shortCommit
} from "./appUpdates.ts";

const current = {
  channel: "main-production",
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  version: "0.1.9"
};

function release(overrides = {}) {
  return {
    html_url: "https://github.com/boriemannetje/apex-notes/releases/tag/main-production",
    name: "Apex Notes main production",
    target_commitish: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    assets: [
      {
        name: MAIN_PRODUCTION_DMG_ASSET,
        browser_download_url: MAIN_PRODUCTION_DMG_DOWNLOAD_URL
      }
    ],
    ...overrides
  };
}

test("getUpdateAvailability reports a main-production update when release commit differs", () => {
  const availability = getUpdateAvailability(current, release());

  assert.equal(availability.available, true);
  if (!availability.available) throw new Error("Expected update");
  assert.equal(availability.currentCommit, current.commit);
  assert.equal(availability.releaseCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(availability.shortCommit, "bbbbbbb");
});

test("getUpdateAvailability stays commit-based across app version bumps", () => {
  const availability = getUpdateAvailability(
    { ...current, version: "0.1.9" },
    release({
      name: "Apex Notes main production",
      body: "Production build from main. App version: 0.1.10."
    })
  );

  assert.equal(availability.available, true);
  if (!availability.available) throw new Error("Expected update");
  assert.equal(availability.releaseCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(availability.currentCommit, current.commit);
});

test("getUpdateAvailability hides the button when current commit matches release", () => {
  assert.deepEqual(
    getUpdateAvailability({ ...current, commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, release()),
    { available: false, reason: "current" }
  );
});

test("getUpdateAvailability rejects missing or unexpected release assets", () => {
  assert.deepEqual(getUpdateAvailability(current, release({ assets: [] })), {
    available: false,
    reason: "invalid-release"
  });
  assert.deepEqual(
    getUpdateAvailability(
      current,
      release({
        assets: [{ name: MAIN_PRODUCTION_DMG_ASSET, browser_download_url: "https://example.com/app.dmg" }]
      })
    ),
    { available: false, reason: "invalid-release" }
  );
});

test("getUpdateAvailability does not prompt dev builds that lack an embedded commit", () => {
  assert.deepEqual(getUpdateAvailability({ ...current, commit: "dev" }, release()), {
    available: false,
    reason: "missing-current-commit"
  });
});

test("getUpdateAvailability ignores non-production channel builds", () => {
  assert.deepEqual(getUpdateAvailability({ ...current, channel: "local" }, release()), {
    available: false,
    reason: "non-production-build"
  });
});

test("findReleaseAsset and URL helpers are strict about the main-production DMG", () => {
  const candidate = findReleaseAsset(release(), MAIN_PRODUCTION_DMG_ASSET);
  assert.equal(candidate?.name, MAIN_PRODUCTION_DMG_ASSET);
  assert.equal(isMainProductionDownloadUrl(candidate?.browser_download_url || ""), true);
  assert.equal(isMainProductionDownloadUrl("https://github.com/boriemannetje/apex-notes/releases/download/old/app.dmg"), false);
  assert.equal(
    isMainProductionDownloadUrl(
      "https://github.com/boriemannetje/apex-notes/releases/download/main-production/other.dmg"
    ),
    false
  );
  assert.equal(normalizeCommit(" ABC "), "abc");
  assert.equal(shortCommit("123456789"), "1234567");
});

test("checkForAppUpdate fetches the GitHub release and applies availability rules", async () => {
  const fakeFetch = async (url, options) => {
    assert.match(String(url), /main-production/);
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    return {
      ok: true,
      status: 200,
      json: async () => release()
    };
  };

  const availability = await checkForAppUpdate({ current, fetchImpl: fakeFetch });
  assert.equal(availability.available, true);
});

test("checkForAppUpdate surfaces failed update checks", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await assert.rejects(
    () => checkForAppUpdate({ current, fetchImpl: fakeFetch }),
    /Update check failed: 500/
  );
});
