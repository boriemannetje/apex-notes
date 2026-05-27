declare const __APEX_NOTES_BUILD_CHANNEL__: string | undefined;
declare const __APEX_NOTES_BUILD_COMMIT__: string | undefined;
declare const __APEX_NOTES_BUILD_VERSION__: string | undefined;

export const MAIN_PRODUCTION_RELEASE_API_URL =
  "https://api.github.com/repos/boriemannetje/apex-notes/releases/tags/main-production";
export const MAIN_PRODUCTION_DMG_ASSET = "apex-notes-main-macos-arm64.dmg";
export const MAIN_PRODUCTION_DOWNLOAD_PREFIX =
  "https://github.com/boriemannetje/apex-notes/releases/download/main-production/";
export const MAIN_PRODUCTION_DMG_DOWNLOAD_URL =
  `${MAIN_PRODUCTION_DOWNLOAD_PREFIX}${MAIN_PRODUCTION_DMG_ASSET}`;

export interface BuildInfo {
  channel: string;
  commit: string;
  version: string;
}

export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface GitHubRelease {
  html_url?: string;
  name?: string;
  published_at?: string;
  target_commitish?: string;
  assets?: ReleaseAsset[];
}

export interface AppUpdateInfo {
  available: boolean;
  channel: string;
  currentCommit: string;
  downloadUrl: string;
  htmlUrl: string;
  releaseCommit: string;
  releaseName: string;
  shortCommit: string;
}

export interface NoAppUpdateInfo {
  available: false;
  reason: "current" | "invalid-release" | "missing-current-commit" | "non-production-build";
}

export type AppUpdateAvailability = AppUpdateInfo | NoAppUpdateInfo;
export type UpdateFetch = (
  input: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<GitHubRelease>;
}>;

export function getCurrentBuildInfo(): BuildInfo {
  return {
    channel: typeof __APEX_NOTES_BUILD_CHANNEL__ === "string" ? __APEX_NOTES_BUILD_CHANNEL__ : "main-production",
    commit: typeof __APEX_NOTES_BUILD_COMMIT__ === "string" ? __APEX_NOTES_BUILD_COMMIT__ : "dev",
    version: typeof __APEX_NOTES_BUILD_VERSION__ === "string" ? __APEX_NOTES_BUILD_VERSION__ : "0.0.0"
  };
}

export async function fetchMainProductionRelease(fetchImpl: UpdateFetch = fetch as unknown as UpdateFetch): Promise<GitHubRelease> {
  const response = await fetchImpl(MAIN_PRODUCTION_RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`Update check failed: ${response.status}`);
  }

  return response.json();
}

export function getUpdateAvailability(
  current: BuildInfo,
  release: GitHubRelease
): AppUpdateAvailability {
  const releaseCommit = normalizeCommit(release.target_commitish);
  const currentCommit = normalizeCommit(current.commit);
  const dmg = findReleaseAsset(release, MAIN_PRODUCTION_DMG_ASSET);

  if (current.channel !== "main-production") {
    return { available: false, reason: "non-production-build" };
  }

  if (!releaseCommit || !dmg?.browser_download_url || !isMainProductionDownloadUrl(dmg.browser_download_url)) {
    return { available: false, reason: "invalid-release" };
  }

  if (!currentCommit || currentCommit === "dev") {
    return { available: false, reason: "missing-current-commit" };
  }

  if (releaseCommit === currentCommit) {
    return { available: false, reason: "current" };
  }

  return {
    available: true,
    channel: current.channel,
    currentCommit,
    downloadUrl: dmg.browser_download_url,
    htmlUrl: release.html_url || "",
    releaseCommit,
    releaseName: release.name || "Apex Notes main production",
    shortCommit: shortCommit(releaseCommit)
  };
}

export async function checkForAppUpdate({
  current = getCurrentBuildInfo(),
  fetchImpl = fetch as unknown as UpdateFetch
}: {
  current?: BuildInfo;
  fetchImpl?: UpdateFetch;
} = {}): Promise<AppUpdateAvailability> {
  const release = await fetchMainProductionRelease(fetchImpl);
  return getUpdateAvailability(current, release);
}

export function findReleaseAsset(release: GitHubRelease, assetName: string): ReleaseAsset | null {
  return (release.assets || []).find((asset) => asset.name === assetName) || null;
}

export function isMainProductionDownloadUrl(url: string): boolean {
  return url === MAIN_PRODUCTION_DMG_DOWNLOAD_URL;
}

export function normalizeCommit(commit: unknown): string {
  return typeof commit === "string" ? commit.trim().toLowerCase() : "";
}

export function shortCommit(commit: string): string {
  return normalizeCommit(commit).slice(0, 7);
}
