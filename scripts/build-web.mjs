import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const minify = process.argv.includes("--minify");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function currentCommit() {
  if (process.env.APEX_NOTES_BUILD_COMMIT) return process.env.APEX_NOTES_BUILD_COMMIT;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

function buildChannel() {
  if (process.env.APEX_NOTES_BUILD_CHANNEL) return process.env.APEX_NOTES_BUILD_CHANNEL;
  if (process.env.GITHUB_REF_NAME === "main") return "main-production";
  return "local";
}

await build({
  bundle: true,
  define: {
    __APEX_NOTES_BUILD_CHANNEL__: JSON.stringify(buildChannel()),
    __APEX_NOTES_BUILD_COMMIT__: JSON.stringify(currentCommit()),
    __APEX_NOTES_BUILD_VERSION__: JSON.stringify(packageJson.version)
  },
  entryPoints: ["web/appBoot.ts"],
  format: "iife",
  loader: {
    ".md": "text"
  },
  minify,
  outfile: "web/app.bundle.js"
});
