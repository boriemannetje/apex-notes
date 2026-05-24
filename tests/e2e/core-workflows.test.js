import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = path.join(repoRoot, "web");

let server;
let baseUrl;
let browser;

test.before(async () => {
  ({ server, baseUrl } = await serveWebRoot());
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("core Tauri workspace flows keep working", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });

  assert.equal(await isVisible(page, "#launchScreen"), true);
  assert.equal(await page.locator("#openFolderButton").count(), 0);
  assert.equal(await page.locator("#createFolderButton").count(), 0);

  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  assert.equal(await isVisible(page, "#launchScreen"), false);
  assert.equal(await page.locator("#graphWorkspaceName").count(), 0);
  assert.equal(await textContent(page, ".workspaceTab.active .workspaceTabTitle"), "Smoke Notes");
  assert.equal(await textContent(page, "#noteTitle"), "Root");
  assert.equal(await textContent(page, "#notePath"), "root.md");

  await assertMainWorkspaceGeometry(page);
  await assertGraphNode(page, "root.md");
  await assertGraphNode(page, "child.md");

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");
  assert.equal(await textContent(page, "#noteTitle"), "Child");

  await page.locator("#newNoteButton").click();
  await page.locator("#newNoteTitle").fill("Grandchild");
  await page.locator("#newNoteParent").selectOption("child.md");
  await page.locator("#newNoteForm button[type='submit']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "grandchild.md");

  const createdRaw = await noteRaw(page, "grandchild.md");
  assert.match(createdRaw, /title: "Grandchild"/);
  assert.match(createdRaw, /level: 2/);
  assert.match(createdRaw, /parent: "\[\[child\]\]"/);
  assert.equal(await textContent(page, "#editorStatus"), "Note created");

  await page.locator("#noteInfo summary").click();
  await page.locator("#infoTitle").fill("Renamed Grandchild");
  await page.locator("#infoParent").selectOption("root.md");
  await page.waitForFunction(() => window.__apexTestState.calls.some(
    (call) => call.command === "write_note" && call.args.path === "grandchild.md"
  ));

  const renamedRaw = await noteRaw(page, "grandchild.md");
  assert.match(renamedRaw, /title: "Renamed Grandchild"/);
  assert.match(renamedRaw, /level: 1/);
  assert.match(renamedRaw, /parent: "\[\[root\]\]"/);
  assert.equal(await textContent(page, "#noteTitle"), "Renamed Grandchild");

  await page.close();
});

test("workspace chrome supports rename and fullscreen without losing the graph", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator(".workspaceTab.active").dblclick();
  await page.locator("[data-rename-workspace]").waitFor();
  await page.waitForFunction(() => document.activeElement?.matches("[data-rename-workspace]"));

  await page.locator("[data-rename-workspace]").fill("Renamed Smoke Notes");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".workspaceTab.active")?.textContent?.includes("Renamed Smoke Notes"));

  assert.equal(await textContent(page, ".workspaceTab.active .workspaceTabTitle"), "Renamed Smoke Notes");
  assert.equal(await page.evaluate(() => window.__apexTestState.workspace.workspaceName), "Renamed Smoke Notes");
  await assertGraphNode(page, "root.md");

  await page.locator("#fullscreenGraphButton").click();
  await page.waitForFunction(() => document.body.classList.contains("graphFullscreen"));
  assert.equal(await isVisible(page, "#graph"), true);
  assert.equal(await page.locator(".editorPane").evaluate((element) => getComputedStyle(element).display), "none");

  await page.locator("#fullscreenGraphButton").click();
  await page.waitForFunction(() => !document.body.classList.contains("graphFullscreen"));
  assert.equal(await isVisible(page, ".editorPane"), true);

  await page.close();
});

test("editor resize separator supports pointer drag, persistence, and keyboard control", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  const initial = await workspaceMetrics(page);
  await dragEditorResizeHandle(page, -160);
  const widened = await workspaceMetrics(page);
  assert(widened.editorPane.width > initial.editorPane.width + 120);
  assert.equal(Math.round(widened.graphPane.width), Math.round(initial.graphPane.width));
  assert.equal(Math.round(widened.graph.width), Math.round(initial.graph.width));
  assert(widened.editorPane.x > widened.graphPane.x);
  assert(widened.editorPane.x < widened.graphPane.x + widened.graphPane.width);
  assert(widened.graph.width > 0);
  assert(widened.graph.height > 0);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  const restored = await workspaceMetrics(page);
  assert(Math.abs(restored.editorPane.width - widened.editorPane.width) <= 2);
  assert.equal(Math.round(restored.graphPane.width), Math.round(initial.graphPane.width));
  assert.equal(Math.round(restored.graph.width), Math.round(initial.graph.width));

  const handle = page.locator("#editorResizeHandle");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  const narrowedByKey = await workspaceMetrics(page);
  assert(narrowedByKey.editorPane.width < restored.editorPane.width);
  assert.equal(Math.round(narrowedByKey.graph.width), Math.round(initial.graph.width));

  await page.keyboard.press("Home");
  const minimum = await workspaceMetrics(page);
  assert(Math.abs(minimum.editorPane.width - 344) <= 2);
  assert.equal(await handle.getAttribute("aria-valuenow"), "344");

  await page.keyboard.press("End");
  const maximum = await workspaceMetrics(page);
  assert(maximum.editorPane.width > minimum.editorPane.width);
  assert.equal(
    Math.round(maximum.editorPane.width),
    Number(await handle.getAttribute("aria-valuemax"))
  );
  assert.equal(Math.round(maximum.graphPane.width), Math.round(initial.graphPane.width));
  assert.equal(Math.round(maximum.graph.width), Math.round(initial.graph.width));
  assert(maximum.graph.width > 0);
  assert(maximum.graph.height > 0);

  await page.locator("#resetViewButton").click();
  await page.waitForTimeout(650);
  const fitted = await workspaceMetrics(page);
  assert.equal(Math.round(fitted.graphPane.width), Math.round(initial.graphPane.width));
  assert.equal(Math.round(fitted.graph.width), Math.round(initial.graph.width));
  assert(fitted.nodeDots.left >= fitted.graphPane.x);
  assert(fitted.nodeDots.right <= fitted.editorPane.x - 8);

  await page.close();
});

async function newMockedTauriPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((seedWorkspace) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const state = {
      workspace: clone(seedWorkspace),
      calls: []
    };

    const signatureFor = (note) => `${note.path}:${note.raw.length}`;
    const noteFiles = () => state.workspace.notes.map((note) => ({
      path: note.path,
      raw: note.raw,
      modifiedMs: 1,
      byteLen: note.raw.length,
      signature: signatureFor(note)
    }));

    window.__apexTestState = state;
    window.__TAURI__ = {
      dialog: {
        open: async () => state.workspace.rootPath
      },
      core: {
        invoke: async (command, args = {}) => {
          state.calls.push({ command, args: clone(args) });

          if (command === "read_recent_projects") return [];
          if (command === "default_project_location") return "/tmp";
          if (command === "read_workspace") return clone(state.workspace);
          if (command === "list_note_files") return noteFiles();
          if (command === "read_notes") {
            return noteFiles().filter((note) => args.paths?.includes(note.path));
          }
          if (command === "create_note") {
            if (state.workspace.notes.some((note) => note.path === args.path)) {
              throw new Error(`Note already exists: ${args.path}`);
            }
            state.workspace.notes.push({ path: args.path, raw: args.raw });
            return null;
          }
          if (command === "write_note") {
            const note = state.workspace.notes.find((item) => item.path === args.path);
            if (!note) throw new Error(`Missing note: ${args.path}`);
            note.raw = args.raw;
            return null;
          }
          if (command === "trash_notes") {
            state.workspace.notes = state.workspace.notes.filter((note) => !args.paths.includes(note.path));
            return null;
          }
          if (command === "write_manifest") {
            state.workspace.manifest = clone(args.paths || []);
            return null;
          }
          if (command === "write_layout_patch") {
            state.workspace.positions = {
              ...(state.workspace.positions || {}),
              ...(args.patch || {})
            };
            return null;
          }
          if (command === "rename_workspace") {
            state.workspace.workspaceName = args.folderName;
            state.workspace.rootPath = `/tmp/${args.folderName}`;
            state.workspace.notesPath = `${state.workspace.rootPath}/notes`;
            return clone(state.workspace);
          }
          if (command === "remember_recent_project" || command === "forget_recent_project") return [];

          throw new Error(`Unhandled test Tauri command: ${command}`);
        }
      }
    };
  }, sampleWorkspace());
  return page;
}

function sampleWorkspace() {
  return {
    rootPath: "/tmp/smoke-notes",
    notesPath: "/tmp/smoke-notes/notes",
    workspaceName: "Smoke Notes",
    source: "folder",
    positions: {},
    notes: [
      {
        path: "root.md",
        raw: [
          "---",
          'title: "Root"',
          "level: 0",
          "parent: null",
          "---",
          "",
          "# Root",
          "",
          "This root links to [[child]]."
        ].join("\n")
      },
      {
        path: "child.md",
        raw: [
          "---",
          'title: "Child"',
          "level: 1",
          'parent: "[[root]]"',
          "---",
          "",
          "# Child",
          "",
          "A child note."
        ].join("\n")
      }
    ]
  };
}

async function assertMainWorkspaceGeometry(page) {
  const metrics = await workspaceMetrics(page);

  assert.equal(metrics.bodyClass, "");
  assert(metrics.tabs.height >= 36);
  assert.equal(metrics.tabs.y, 0);
  assert(metrics.topbar.y >= metrics.tabs.height);
  assert(metrics.graphPane.width > 800);
  assert(metrics.resizeHandle.width >= 8);
  assert(metrics.editorPane.width > 360);
  assert(metrics.graph.height > 500);
  assert(metrics.search.width >= 300);
  assert(metrics.newNote.width >= 90);
}

async function workspaceMetrics(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      } : null;
    };
    const boxes = (selector) => Array.from(document.querySelectorAll(selector))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const bounds = (selector) => {
      const rects = boxes(selector);
      if (!rects.length) return null;
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        left,
        right,
        top,
        bottom
      };
    };

    return {
      bodyClass: document.body.className,
      tabs: box("#workspaceTabs"),
      topbar: box(".topbar"),
      graphPane: box(".graphPane"),
      resizeHandle: box("#editorResizeHandle"),
      editorPane: box(".editorPane"),
      graph: box("#graph"),
      nodeDots: bounds(".nodeDot"),
      search: box(".searchField"),
      newNote: box("#newNoteButton")
    };
  });
}

async function dragEditorResizeHandle(page, deltaX) {
  const handle = page.locator("#editorResizeHandle");
  const box = await handle.boundingBox();
  assert(box);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 8 });
  await page.mouse.up();
}

async function assertGraphNode(page, path) {
  const node = page.locator(`.node[data-path='${path}']`);
  await node.waitFor();
  assert.equal(await node.count(), 1);
}

async function noteRaw(page, path) {
  return page.evaluate((notePath) => {
    const note = window.__apexTestState.workspace.notes.find((item) => item.path === notePath);
    return note?.raw || "";
  }, path);
}

async function textContent(page, selector) {
  return (await page.locator(selector).textContent()).trim();
}

async function isVisible(page, selector) {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).display !== "none");
}

async function serveWebRoot() {
  const mimeTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml; charset=utf-8"]
  ]);

  const nextServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const requestPath = requestUrl.pathname === "/" ? "/index.html" : decodeURIComponent(requestUrl.pathname);
    const filePath = path.normalize(path.join(webRoot, requestPath));

    if (!filePath.startsWith(`${webRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      response.setHeader("Content-Type", mimeTypes.get(path.extname(filePath)) || "application/octet-stream");
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolve) => nextServer.listen(0, "127.0.0.1", resolve));
  const address = nextServer.address();
  return {
    server: nextServer,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}
