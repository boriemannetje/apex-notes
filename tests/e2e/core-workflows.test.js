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

  await page.locator("#fullscreenEditorButton").click();
  await page.waitForFunction(() => document.body.classList.contains("editorFullscreen"));
  assert.equal(await isVisible(page, ".editorPane"), true);
  assert.equal(await page.locator(".graphPane").evaluate((element) => getComputedStyle(element).visibility), "hidden");
  assert.equal(await page.locator("#fullscreenEditorButton").getAttribute("aria-label"), "Exit full screen editor");

  await page.locator("#fullscreenEditorButton").click();
  await page.waitForFunction(() => !document.body.classList.contains("editorFullscreen"));
  assert.equal(await isVisible(page, ".graphPane"), true);
  assert.equal(await page.locator("#fullscreenEditorButton").getAttribute("aria-label"), "Enter full screen editor");

  await page.close();
});

test("pasting plain text into the graph creates a loose note", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");
  await page.locator("#searchInput").fill("");

  await page.evaluate(() => {
    window.__apexTestState.clipboardText = "# Pasted Loose\n\nA loose pasted note.";
  });
  await page.locator("#graph").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "pasted-loose.md");

  const pastedRaw = await noteRaw(page, "pasted-loose.md");
  assert.match(pastedRaw, /title: "Pasted Loose"/);
  assert.match(pastedRaw, /level: 0/);
  assert.match(pastedRaw, /parent: null/);
  assert.equal(await textContent(page, "#editorStatus"), "Pasted text as note");

  await page.close();
});

test("main-production update button appears and invokes native update install", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), {
    updateRelease: {
      target_commitish: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      assets: [
        {
          name: "apex-notes-main-macos-arm64.dmg",
          browser_download_url:
            "https://github.com/boriemannetje/apex-notes/releases/download/main-production/apex-notes-main-macos-arm64.dmg"
        }
      ]
    }
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  const updateButton = page.getByRole("button", { name: /install apex notes update/i });
  await updateButton.waitFor();
  await updateButton.click();

  const installCall = await page.waitForFunction(() => {
    return window.__apexTestState.calls.find((call) => call.command === "install_app_update");
  });
  const call = await installCall.jsonValue();
  assert.equal(call.args.releaseCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.match(call.args.downloadUrl, /apex-notes-main-macos-arm64\.dmg$/);

  await page.close();
});

test("empty graph create hint stays centered in the visible graph area", async () => {
  const page = await newMockedTauriPage(emptyWorkspace());

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  const metrics = await workspaceMetrics(page);
  const hintX = Number(await page.locator(".emptyGraphText").getAttribute("x"));
  const expectedX = (metrics.graphPane.x + metrics.resizeHandle.x) / 2;

  assert.equal(await textContent(page, ".emptyGraphText"), "Click the graph to create the first note");
  assert(Math.abs(hintX - expectedX) < 2);
  assert(hintX < metrics.graph.width / 2);

  await page.close();
});

test("project chooser hides the editor until another project is opened or created", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  assert.equal(await isVisible(page, ".editorPane"), true);
  await page.getByRole("button", { name: "Open another notes folder" }).click();
  await page.locator("#graphProjectLauncher").waitFor();

  const metrics = await workspaceMetrics(page);
  assert.match(metrics.bodyClass, /\bprojectChooserOpen\b/);
  assert.equal(await isVisible(page, ".editorPane"), false);
  assert.equal(await page.locator("#editorResizeHandle").evaluate((element) => getComputedStyle(element).display), "none");
  assert(metrics.topbar.width > 1100);
  assert.equal(await page.locator("#graphProjectLauncher").getAttribute("aria-hidden"), "false");

  await page.getByRole("button", { name: "Return to graph" }).click();
  await page.waitForFunction(() => !document.body.classList.contains("projectChooserOpen"));
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

  await dragEditorResizeHandle(page, 420);
  const narrowedByDrag = await workspaceMetrics(page);
  const desktopMinWidth = Number(await handle.getAttribute("aria-valuemin"));
  assert.equal(desktopMinWidth, 260);
  assert(narrowedByDrag.editorPane.width < initial.editorPane.width - 120);
  assert(Math.abs(narrowedByDrag.editorPane.width - desktopMinWidth) <= 2);
  assert(narrowedByDrag.editorPane.x > narrowedByDrag.graphPane.x);
  assert(narrowedByDrag.editorPane.x + narrowedByDrag.editorPane.width <= narrowedByDrag.viewport.width + 1);
  assert(narrowedByDrag.search.width >= 300);

  await page.keyboard.press("Home");
  const minimum = await workspaceMetrics(page);
  assert(Math.abs(minimum.editorPane.width - desktopMinWidth) <= 2);
  assert.equal(await handle.getAttribute("aria-valuenow"), String(desktopMinWidth));

  await page.setViewportSize({ width: 760, height: 720 });
  await page.waitForFunction(() => {
    const editor = document.querySelector(".editorPane")?.getBoundingClientRect();
    return editor && editor.right <= window.innerWidth + 1;
  });
  const responsive = await workspaceMetrics(page);
  assert(responsive.viewport.width === 760);
  assert(responsive.editorPane.width <= 270);
  assert(responsive.editorPane.x + responsive.editorPane.width <= responsive.viewport.width + 1);
  assert(responsive.resizeHandle.x > responsive.graphPane.x);
  assert(responsive.graph.height > 450);
  assert(responsive.search.width >= 160);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.innerWidth === 1440);

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
  assert(fitted.nodeContent.left >= fitted.graphPane.x);
  assert(fitted.nodeContent.top >= fitted.graph.y);
  assert(fitted.nodeContent.right <= fitted.editorPane.x - 8);
  assert(fitted.nodeContent.bottom <= fitted.graph.y + fitted.graph.height);
  const visibleCenter = (fitted.graphPane.x + fitted.editorPane.x - 8) / 2;
  const contentCenter = (fitted.nodeContent.left + fitted.nodeContent.right) / 2;
  assert(Math.abs(contentCenter - visibleCenter) < 36);

  await page.close();
});

async function newMockedTauriPage(workspace = sampleWorkspace(), options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(({ seedWorkspace, seedUpdateRelease }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const state = {
      workspace: clone(seedWorkspace),
      calls: [],
      clipboardText: "",
      updateRelease: seedUpdateRelease
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
    window.fetch = async () => ({
      ok: true,
      json: async () => state.updateRelease
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => state.clipboardText,
        writeText: async (text) => {
          state.clipboardText = String(text || "");
        }
      }
    });
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
          if (command === "create_notes") {
            for (const note of args.notes || []) {
              if (state.workspace.notes.some((item) => item.path === note.path)) {
                throw new Error(`Note already exists: ${note.path}`);
              }
              state.workspace.notes.push({ path: note.path, raw: note.raw });
            }
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
              ...(args.updates || args.patch || {})
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
          if (command === "install_app_update") return null;

          throw new Error(`Unhandled test Tauri command: ${command}`);
        }
      }
    };
  }, {
    seedWorkspace: workspace,
    seedUpdateRelease: options.updateRelease || { target_commitish: "", assets: [] }
  });
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

function emptyWorkspace() {
  return {
    rootPath: "/tmp/empty-notes",
    notesPath: "/tmp/empty-notes/notes",
    workspaceName: "Empty Notes",
    source: "folder",
    positions: {},
    notes: []
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
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
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
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      tabs: box("#workspaceTabs"),
      topbar: box(".topbar"),
      graphPane: box(".graphPane"),
      resizeHandle: box("#editorResizeHandle"),
      editorPane: box(".editorPane"),
      graph: box("#graph"),
      nodeDots: bounds(".nodeDot"),
      nodeContent: bounds(".nodeDot, .nodeLabel"),
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
