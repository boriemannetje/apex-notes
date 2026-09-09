import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = path.join(repoRoot, "web");
const mainProductionDmgUrl =
  "https://github.com/boriemannetje/apex-notes/releases/download/main-production/apex-notes-main-macos-arm64.dmg";

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
  assert.equal(await textContent(page, "#validationStatus"), "Valid");

  await assertMainWorkspaceGeometry(page);
  await assertGraphNode(page, "root.md");
  await assertGraphNode(page, "child.md");

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");
  assert.equal(await textContent(page, "#noteTitle"), "Child");
  const markdownLink = page.locator(".cm-markdownLink");
  assert.equal(await markdownLink.count(), 1);
  assert.equal(await markdownLink.textContent(), "Waymo for Business");
  assert.equal(await markdownLink.getAttribute("href"), "https://waymo.com/business/");
  assert.equal(await markdownLink.getAttribute("target"), "_blank");
  assert.equal(await markdownLink.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await markdownLink.evaluate((element) => getComputedStyle(element).color), "rgb(159, 207, 255)");
  assert.equal((await page.locator(".cm-content").innerText()).includes("https://waymo.com/business/"), false);
  assert.equal((await page.locator(".cm-content").innerText()).includes("javascript:alert(1)"), true);

  await page.locator("#newNoteButton").click();
  await page.locator("#newNoteTitle").fill("Grandchild");
  await page.locator("#newNoteParent").selectOption("child.md");
  await page.locator("#newNoteForm button[type='submit']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "grandchild.md");

  const createdRaw = await noteRaw(page, "grandchild.md");
  assert.match(createdRaw, /title: "Grandchild"/);
  assert.doesNotMatch(createdRaw, /\nlevel:/);
  assert.match(createdRaw, /parent: "\[\[child\]\]"/);
  assert.doesNotMatch(createdRaw, /\n# Grandchild\n/);
  await page.locator(".cm-placeholder").waitFor();
  assert.equal(await textContent(page, ".cm-placeholder"), "Write down your thoughts...");
  assert.equal(await textContent(page, "#editorStatus"), "Note created");

  assert.equal(await page.locator("#infoTitle").count(), 0);
  await renameSelectedNoteTitle(page, "Renamed Grandchild");
  await page.locator("#noteInfo summary").click();
  await page.locator("#infoParent").selectOption("root.md");
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.some(
    (note) => note.path === "grandchild.md" &&
      note.raw.includes('title: "Renamed Grandchild"') &&
      note.raw.includes('parent: "[[root]]"')
  ));

  const renamedRaw = await noteRaw(page, "grandchild.md");
  assert.match(renamedRaw, /title: "Renamed Grandchild"/);
  assert.doesNotMatch(renamedRaw, /\nlevel:/);
  assert.match(renamedRaw, /parent: "\[\[root\]\]"/);
  assert.equal(await textContent(page, "#noteTitle"), "Renamed Grandchild");

  await page.close();
});

test("canvas annotations draw, name, write, undo, reload, and remain behind nodes", async () => {
  const page = await newMockedTauriPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  const graph = await page.locator("#graph").boundingBox();
  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 260, graph.y + 240);
  await page.mouse.down();
  await page.mouse.move(graph.x + 430, graph.y + 310, { steps: 4 });
  await page.mouse.up();
  await page.locator("#annotationEditor").fill("Milestone");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations?.items?.[0]?.name === "Milestone");

  assert.equal(await page.locator(".annotationItem[data-annotation-type='line']").count(), 1);
  assert.equal(await textContent(page, ".annotationLabel"), "Milestone");
  assert.equal(await page.evaluate(() => {
    const canvas = document.querySelector(".graphCanvas");
    return canvas?.firstElementChild?.classList.contains("annotationLayer") &&
      Boolean(canvas.querySelector(".annotationLayer ~ .node"));
  }), true);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 360, graph.y + 430);
  await page.locator("#annotationEditor").fill("First line\nSecond line");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations?.items?.some((item) => item.type === "text" && item.text.includes("Second line")));

  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  await pressShortcut(page, "Y");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 2);
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_annotations")), true);

  await page.locator(".workspaceTabClose").click();
  await page.getByRole("button", { name: "Open project" }).waitFor();
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".annotationItem[data-annotation-type='line']").waitFor();
  assert.equal(await page.locator(".annotationText").count(), 1);
  await page.close();
});

test("annotation-only workspaces fit and corrupt sidecars disable drawing", async () => {
  const annotationOnly = sampleWorkspace();
  annotationOnly.notes = [];
  annotationOnly.annotations = { version: 1, items: [{ id: "box", type: "square", x: 100, y: 120, size: 240, name: "Area" }] };
  const page = await newMockedTauriPage(annotationOnly);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  assert.equal(await page.locator("#resetViewButton").isEnabled(), true);
  await page.locator("#resetViewButton").click();
  await page.waitForTimeout(550);
  assert.equal(await page.locator(".annotationItem[data-annotation-id='box']").count(), 1);
  await page.close();

  const corrupt = sampleWorkspace();
  corrupt.annotationsError = "Unsupported annotations document version";
  const blocked = await newMockedTauriPage(corrupt);
  await blocked.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await blocked.getByRole("button", { name: "Open project" }).click();
  assert.equal(await blocked.locator("[data-annotation-tool='line']").isDisabled(), true);
  assert.equal(await blocked.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_annotations")), false);
  await blocked.close();
});

test("annotation tools support pen and constrained shapes without rebuilding the graph per frame", async () => {
  const page = await newMockedTauriPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  for (const [tool, start, end] of [
    ["pen", [240, 380], [330, 420]],
    ["square", [520, 220], [610, 300]],
    ["circle", [540, 430], [620, 480]]
  ]) {
    await page.locator(`[data-annotation-tool='${tool}']`).click();
    await page.mouse.move(graph.x + start[0], graph.y + start[1]);
    await page.mouse.down();
    await page.mouse.move(graph.x + end[0], graph.y + end[1], { steps: 5 });
    await page.mouse.up();
    if (tool !== "pen") {
      await page.locator("#annotationEditor").fill(`${tool} name`);
      await page.locator("#annotationEditor").press("Enter");
    }
  }
  assert.equal(await page.locator(".annotationItem[data-annotation-type='stroke']").count(), 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-type='square']").count(), 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-type='circle']").count(), 1);
  assert.deepEqual(await page.locator(".annotationLabel").allTextContents(), ["square name", "circle name"]);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 700, graph.y + 240);
  await page.mouse.down();
  await page.mouse.move(graph.x + 760, graph.y + 280);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await page.locator(".annotationItem[data-annotation-type='line']").count(), 0);

  const node = await page.locator(".node[data-path='root.md']").boundingBox();
  assert(node);
  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  await page.mouse.move(node.x + node.width / 2 + 90, node.y + node.height / 2 + 30, { steps: 3 });
  await page.mouse.up();
  await page.locator("#annotationEditor").press("Escape");
  assert.equal(await page.locator(".annotationItem[data-annotation-type='line']").count(), 1);
  assert.equal(await page.locator(".node[data-path='root.md']").count(), 1);

  const beforePanCount = await page.locator(".annotationItem").count();
  await page.locator("[data-annotation-tool='circle']").click();
  await page.keyboard.down("Alt");
  await page.mouse.move(graph.x + 850, graph.y + 500);
  await page.mouse.down();
  await page.mouse.move(graph.x + 900, graph.y + 540);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(graph.x + 920, graph.y + 560);
  await page.mouse.up({ button: "middle" });
  assert.equal(await page.locator(".annotationItem").count(), beforePanCount);

  await page.locator("[data-annotation-tool='select']").click();
  const squareHit = page.locator(".annotationItem[data-annotation-type='square'] .annotationHit");
  const squareBox = await squareHit.boundingBox();
  assert(squareBox);
  await page.mouse.move(squareBox.x + 2, squareBox.y + squareBox.height / 2);
  await page.mouse.down();
  await page.evaluate(() => { window.__annotationCanvasBeforeMove = document.querySelector(".graphCanvas"); });
  await page.mouse.move(squareBox.x + 42, squareBox.y + squareBox.height / 2 + 25, { steps: 5 });
  await page.waitForTimeout(40);
  assert.equal(await page.evaluate(() => window.__annotationCanvasBeforeMove === document.querySelector(".graphCanvas")), true);
  await page.mouse.up();

  const handle = page.locator(".annotationItem[data-annotation-type='square'] .annotationHandleHit");
  await handle.dragTo(page.locator("#graph"), { targetPosition: { x: 800, y: 600 } });
  assert.equal(await page.locator(".annotationItem[data-annotation-type='square']").count(), 1);

  await page.close();
});

test("annotation labels, keyboard access, viewport clamping, wheel routing, and selection are reliable", async () => {
  const workspace = sampleWorkspace();
  workspace.annotations.items = [
    { id: "named-line", type: "line", x1: 80, y1: 100, x2: 280, y2: 100, name: "Old label" },
    { id: "edge-text", type: "text", x: 1_200, y: 800, text: "Edge text" }
  ];
  const page = await newMockedTauriPage(workspace);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();

  await page.locator(".annotationLabelHit").dblclick();
  await page.locator("#annotationEditor").fill("Renamed label");
  await page.locator("#annotationEditor").press("Enter");
  await page.waitForFunction(() => document.querySelector(".annotationLabel")?.textContent === "Renamed label");

  const lineItem = page.locator(".annotationItem[data-annotation-id='named-line']");
  assert.equal(await lineItem.getAttribute("role"), "graphics-symbol");
  assert.equal(await lineItem.getAttribute("tabindex"), "0");
  await lineItem.focus();
  await page.keyboard.press("Space");
  assert.equal(await lineItem.getAttribute("class"), "annotationItem selected");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#annotationEditor").isVisible(), true);

  const graphBox = await page.locator("#graph").boundingBox();
  const editorBox = await page.locator("#annotationEditor").boundingBox();
  assert(graphBox && editorBox);
  assert(editorBox.x >= graphBox.x - 1 && editorBox.y >= graphBox.y - 1);
  assert(editorBox.x + editorBox.width <= graphBox.x + graphBox.width + 1);
  assert(editorBox.y + editorBox.height <= graphBox.y + graphBox.height + 1);

  const scaleBeforeEditorWheel = (await graphWheelSnapshot(page, graphBox.x + 400, graphBox.y + 300)).scale;
  await page.locator("#annotationEditor").dispatchEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
  assert.equal((await graphWheelSnapshot(page, graphBox.x + 400, graphBox.y + 300)).scale, scaleBeforeEditorWheel);
  await page.locator("#annotationEditor").press("Escape");

  await page.locator(".annotationItem[data-annotation-id='edge-text']").focus();
  await page.keyboard.press("Enter");
  const edgeEditorBox = await page.locator("#annotationEditor").boundingBox();
  assert(edgeEditorBox);
  assert(edgeEditorBox.x >= graphBox.x - 1 && edgeEditorBox.y >= graphBox.y - 1);
  assert(edgeEditorBox.x + edgeEditorBox.width <= graphBox.x + graphBox.width + 1);
  assert(edgeEditorBox.y + edgeEditorBox.height <= graphBox.y + graphBox.height + 1);
  await page.locator("#annotationEditor").press("Escape");

  const labelBox = await page.locator(".annotationLabelHit").boundingBox();
  assert(labelBox);
  const annotationWheel = await page.locator(".annotationLabelHit").evaluate((element, init) => {
    const event = new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  }, { clientX: labelBox.x + labelBox.width / 2, clientY: labelBox.y + labelBox.height / 2, deltaY: -100 });
  assert.equal(annotationWheel.defaultPrevented, true);

  await lineItem.click();
  await page.locator(".node[data-path='root.md']").click();
  await page.keyboard.press("Delete");
  assert.equal(await page.locator(".annotationItem[data-annotation-id='named-line']").count(), 1);
  if (await page.locator("#deleteConfirmDialog").evaluate((element) => element.open)) {
    await page.locator("#cancelDeleteButton").click();
  }
  await page.locator(".annotationLabelHit").click();
  assert.equal(await page.locator(".annotationItem[data-annotation-id='named-line'] .annotationHandle").count(), 2);
  await page.mouse.click(graphBox.x + graphBox.width - 30, graphBox.y + graphBox.height - 30);
  await page.keyboard.press("Delete");
  assert.equal(await page.locator(".annotationItem[data-annotation-id='named-line']").count(), 1);

  await lineItem.focus();
  await page.keyboard.press("Space");
  const handle = page.locator(".annotationHandle").first();
  const handleBefore = await handle.boundingBox();
  const handleHitBefore = await page.locator(".annotationHandleHit").first().boundingBox();
  await dispatchGraphWheel(page, { clientX: graphBox.x + 400, clientY: graphBox.y + 300, deltaY: -10_000 });
  const handleAfter = await page.locator(".annotationHandle").first().boundingBox();
  const handleHitAfter = await page.locator(".annotationHandleHit").first().boundingBox();
  assert(handleBefore && handleAfter && handleHitBefore && handleHitAfter);
  assert(Math.abs(handleBefore.width - handleAfter.width) < 1.5);
  assert(Math.abs(handleHitBefore.width - handleHitAfter.width) < 1.5);

  await page.locator("#fullscreenGraphButton").click();
  await page.waitForFunction(() => document.body.classList.contains("graphFullscreen"));
  assert.equal(await page.locator(".annotationItem").count(), 2);
  await page.locator("#fullscreenGraphButton").click();
  await page.waitForFunction(() => !document.body.classList.contains("graphFullscreen"));

  await page.locator(".annotationItem[data-annotation-id='edge-text']").press("Space");
  await page.evaluate(() => {
    window.__focusedAnnotationBeforeResize = document.activeElement;
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() => !window.__focusedAnnotationBeforeResize.isConnected);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-annotation-id")), "edge-text");
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector(".annotationItem[data-annotation-id='edge-text']"));
  await page.close();
});

test("delayed annotation saves stay with their originating workspace", async () => {
  const first = sampleWorkspace();
  const second = sampleWorkspace();
  second.rootPath = "/tmp/second-notes";
  second.notesPath = "/tmp/second-notes/notes";
  second.workspaceName = "Second Notes";
  second.annotations = { version: 1, items: [] };
  const page = await newMockedTauriPage(first, { additionalWorkspaces: [second], holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 300, graph.y + 260);
  await page.mouse.down();
  await page.mouse.move(graph.x + 430, graph.y + 320);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator(".workspaceTabAdd").click();
  assert.equal(await page.locator("#annotationToolbar").isVisible(), false);
  assert.equal(await page.locator("#annotationEditor").isVisible(), false);
  await page.locator("#graphOpenProjectButton").click();
  await page.waitForFunction(() => document.querySelector(".workspaceTab.active")?.textContent?.includes("Second Notes"));
  await page.evaluate(() => window.__apexTestState.releaseAnnotationWrite());
  await page.waitForFunction(() => window.__apexTestState.workspaces[0].annotations.items.length === 1);
  assert.equal(await page.locator(".annotationItem").count(), 0);

  await page.getByRole("button", { name: /Switch to folder: Smoke Notes/ }).click();
  await page.locator(".annotationItem[data-annotation-type='line']").waitFor();
  assert.equal(await page.locator(".annotationItem").count(), 1);
  await page.close();
});

test("reopening an externally changed workspace clears stale annotation undo history", async () => {
  const page = await newMockedTauriPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 300, graph.y + 250);
  await page.mouse.down();
  await page.mouse.move(graph.x + 420, graph.y + 290);
  await page.mouse.up();
  await page.locator("#annotationEditor").press("Escape");
  await page.evaluate(() => { window.__apexTestState.workspaces[0].annotations = { version: 1, items: [] }; });

  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".annotationItem").length === 0);
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  assert.equal(await page.locator(".annotationItem").count(), 0);
  await page.close();
});

test("pending annotation writes finish before rename and renamed workspaces preserve undo history", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true, holdRenameWorkspace: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 280, graph.y + 260);
  await page.mouse.down();
  await page.mouse.move(graph.x + 410, graph.y + 310);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator(".workspaceTab.active").dblclick();
  await page.locator("[data-rename-workspace]").fill("Renamed During Save");
  await page.locator("[data-rename-workspace]").press("Enter");
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "rename_workspace")), false);
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.renameWorkspaceResolvers.length === 1);
  const callsAtRenameBarrier = await page.evaluate(() => window.__apexTestState.calls.length);
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await pressShortcut(page, "Y");
  assert.equal(await page.locator("[data-annotation-tool='line']").isDisabled(), true);
  await page.locator("[data-annotation-tool='line']").evaluate((button) => { button.disabled = false; button.click(); });
  await page.mouse.move(graph.x + 520, graph.y + 430);
  await page.mouse.down();
  await page.mouse.move(graph.x + 620, graph.y + 470);
  await page.mouse.up();
  await page.locator(".annotationItem[data-annotation-type='line']").dblclick();
  assert.equal(await page.locator("#annotationEditor").isVisible(), false);
  assert.equal(await page.evaluate((index) => window.__apexTestState.calls.slice(index).some((call) => call.command === "write_annotations"), callsAtRenameBarrier), false);
  await page.evaluate(() => {
    window.__apexTestState.holdRenameWorkspace = false;
    window.__apexTestState.releaseRenameWorkspace();
  });
  await page.waitForFunction(() => document.querySelector(".workspaceTab.active")?.textContent?.includes("Renamed During Save"));
  assert.equal(await page.locator(".annotationItem[data-annotation-type='line']").count(), 1);

  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => document.querySelectorAll(".annotationItem").length === 0);
  await page.close();
});

test("closing and reopening a workspace waits for its delayed annotation write", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 320, graph.y + 300);
  await page.mouse.down();
  await page.mouse.move(graph.x + 450, graph.y + 350);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);
  await page.locator(".workspaceTabClose").click();
  assert.equal(await page.locator(".workspaceTab").count(), 1);
  assert.equal(await page.locator("[data-annotation-tool='line']").isDisabled(), true);
  await page.locator("[data-annotation-tool='line']").evaluate((button) => { button.disabled = false; button.click(); });
  await page.mouse.move(graph.x + 560, graph.y + 410);
  await page.mouse.down();
  await page.mouse.move(graph.x + 650, graph.y + 450);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.filter((call) => call.command === "write_annotations").length), 1);

  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.getByRole("button", { name: "Open project" }).waitFor();
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".annotationItem[data-annotation-type='line']").waitFor();
  assert.equal(await page.locator(".annotationItem").count(), 1);
  await page.close();
});

test("same-folder rehydrate waits for a delayed annotation write before reading", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 330, graph.y + 280);
  await page.mouse.down();
  await page.mouse.move(graph.x + 460, graph.y + 340);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.filter((call) => call.command === "read_workspace").length), 1);
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.calls.filter((call) => call.command === "read_workspace").length === 2);
  await page.locator(".annotationItem[data-annotation-type='line']").waitFor();
  await page.close();
});

test("rapid queued annotation writes retain one undo entry per successful gesture", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 300, graph.y + 320);
  await page.locator("#annotationEditor").fill("First queued text");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 500, graph.y + 420);
  await page.locator("#annotationEditor").fill("Second queued text");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  assert.equal(await page.locator(".annotationItem[data-annotation-type='text']").count(), 2);

  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.calls.filter((call) => call.command === "write_annotations").length >= 2 && window.__apexTestState.workspace.annotations.items.length === 2);
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 0);
  await page.close();
});

test("a superseded failed annotation write is covered by the next persisted document and remains undoable", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), {
    holdAnnotationWrites: true,
    annotationWriteFailures: [true, false]
  });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 310, graph.y + 330);
  await page.locator("#annotationEditor").fill("Survives first failure");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 510, graph.y + 430);
  await page.locator("#annotationEditor").fill("Persists both changes");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.calls.filter((call) => call.command === "write_annotations").length === 2 && window.__apexTestState.workspace.annotations.items.length === 2);
  assert.equal(await page.locator(".annotationItem[data-annotation-type='text']").count(), 2);

  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 0);
  await page.close();
});

test("undo requested during an annotation save waits for its history entry", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 300, graph.y + 350);
  await page.locator("#annotationEditor").fill("Undo after pending save");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.calls.filter((call) => call.command === "write_annotations").length === 2 && window.__apexTestState.workspace.annotations.items.length === 0);
  assert.equal(await page.locator(".annotationItem").count(), 0);
  await pressShortcut(page, "Y");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  await page.close();
});

test("an older successful annotation save preserves and rebases the live next gesture", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), { holdAnnotationWrites: true });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 300, graph.y + 350);
  await page.locator("#annotationEditor").fill("First saved change");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 500, graph.y + 420);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  assert.equal(await page.locator(".annotationItem").count(), 2);

  await page.mouse.move(graph.x + 620, graph.y + 470);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 2);
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => window.__apexTestState.workspace.annotations.items.length === 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-type='text']").count(), 1);
  await page.close();
});

test("a terminal annotation failure cancels a live next gesture without resurrecting failed state", async () => {
  const workspace = sampleWorkspace();
  workspace.annotations.items = [{ id: "on-disk", type: "line", x1: 680, y1: 280, x2: 820, y2: 320, name: "On disk" }];
  const diskSnapshot = structuredClone(workspace.annotations);
  const page = await newMockedTauriPage(workspace, {
    holdAnnotationWrites: true,
    annotationWriteFailures: [true]
  });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 300, graph.y + 360);
  await page.locator("#annotationEditor").fill("Failed change");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);

  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 500, graph.y + 430);
  await page.mouse.down();
  await page.mouse.move(graph.x + 620, graph.y + 480);
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });
  await page.waitForFunction(() => document.querySelector("#editorStatus")?.textContent?.includes("Could not save annotation"));
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.annotations), diskSnapshot);
  assert.equal(await page.locator(".annotationItem").count(), 1);

  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.annotations), diskSnapshot);
  assert.equal(await page.locator(".annotationItem").count(), 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-id='on-disk']").count(), 1);
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.filter((call) => call.command === "write_annotations").length), 1);
  await page.close();
});

test("terminal annotation write failures restore the exact persisted document and reopen identically", async () => {
  const workspace = sampleWorkspace();
  workspace.annotations.items = [{ id: "on-disk", type: "line", x1: 680, y1: 280, x2: 820, y2: 320, name: "On disk" }];
  const diskSnapshot = structuredClone(workspace.annotations);
  const page = await newMockedTauriPage(workspace, {
    holdAnnotationWrites: true,
    annotationWriteFailures: [true, true]
  });
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  const graph = await page.locator("#graph").boundingBox();
  assert(graph);

  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 300, graph.y + 360);
  await page.locator("#annotationEditor").fill("First failed change");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.waitForFunction(() => window.__apexTestState.annotationWriteResolvers.length === 1);
  await page.locator("[data-annotation-tool='text']").click();
  await page.mouse.click(graph.x + 500, graph.y + 440);
  await page.locator("#annotationEditor").fill("Second failed change");
  await page.locator("#annotationEditor").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.evaluate(() => {
    window.__apexTestState.holdAnnotationWrites = false;
    window.__apexTestState.releaseAnnotationWrite();
  });

  await page.waitForFunction(() => document.querySelector("#editorStatus")?.textContent?.includes("Could not save annotation"));
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.annotations), diskSnapshot);
  assert.equal(await page.locator(".annotationItem").count(), 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-id='on-disk']").count(), 1);

  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.waitForFunction(() => window.__apexTestState.calls.filter((call) => call.command === "read_workspace").length === 2);
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.annotations), diskSnapshot);
  assert.equal(await page.locator(".annotationItem").count(), 1);
  assert.equal(await page.locator(".annotationItem[data-annotation-id='on-disk']").count(), 1);
  await page.close();
});

test("annotation selection and drawing preserve an immediately edited open note", async () => {
  const workspace = sampleWorkspace();
  workspace.annotations.items = [{ id: "select-me", type: "line", x1: 700, y1: 300, x2: 850, y2: 330, name: "Select me" }];
  const page = await newMockedTauriPage(workspace);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();

  await page.locator(".cm-content").click();
  await page.keyboard.type("\nRetained after annotation select");
  await page.locator(".annotationLabelHit").click();
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.find((note) => note.path === "root.md")?.raw.includes("Retained after annotation select"));
  assert.equal(await textContent(page, "#notePath"), "root.md");

  await page.locator(".cm-content").click();
  await page.keyboard.type("\nRetained after annotation draw");
  const graph = await page.locator("#graph").boundingBox();
  await page.locator("[data-annotation-tool='line']").click();
  await page.mouse.move(graph.x + 350, graph.y + 500);
  await page.mouse.down();
  await page.mouse.move(graph.x + 470, graph.y + 540);
  await page.mouse.up();
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.find((note) => note.path === "root.md")?.raw.includes("Retained after annotation draw"));
  assert.equal(await textContent(page, "#notePath"), "root.md");
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_note" && call.args.path === "root.md")), true);
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

test("native pinch follows finger scale and Ctrl-wheel pinch remains responsive", async () => {
  const page = await newMockedTauriPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".graphCanvas").waitFor();
  const box = await page.locator("#graph").boundingBox();
  const x = box.x + 280, y = box.y + 250;
  const before = await graphWheelSnapshot(page, x, y);
  const gesture = async (type, scale) => page.locator("#graph").evaluate((el, init) => {
    const event = new Event(init.type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { scale: { value: init.scale }, clientX: { value: init.x }, clientY: { value: init.y } });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, scale, x, y });
  assert(await gesture("gesturestart", 1));
  await gesture("gesturechange", 1.4);
  const enlarged = await graphWheelSnapshot(page, x, y, before.graphPoint);
  assert(Math.abs(enlarged.scale / before.scale - 1.4) < 0.01);
  assert(Math.hypot(enlarged.anchorError.x, enlarged.anchorError.y) < 1, JSON.stringify({ before, enlarged }));
  await page.locator("#graph").dispatchEvent("wheel", { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
  assert.equal((await graphWheelSnapshot(page, x, y)).scale, enlarged.scale);
  await gesture("gesturechange", 1);
  await gesture("gestureend", 1);
  assert(Math.abs((await graphWheelSnapshot(page, x, y)).scale - before.scale) < 0.001);
  await page.locator("#graph").dispatchEvent("wheel", { deltaX: 0, deltaY: -10, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
  assert((await graphWheelSnapshot(page, x, y)).scale / before.scale > 1.1);
  await page.close();
});

test("mouse wheel zoom is continuous, cursor anchored, bounded, and canvas scoped", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();
  await page.locator(".graphCanvas").waitFor();

  const graphBox = await page.locator("#graph").boundingBox();
  assert(graphBox);
  const clientX = graphBox.x + graphBox.width * 0.37;
  const clientY = graphBox.y + graphBox.height * 0.41;
  const before = await graphWheelSnapshot(page, clientX, clientY);

  const zoomInDispatch = await dispatchGraphWheel(page, {
    clientX,
    clientY,
    deltaY: -100
  });
  const zoomedIn = await graphWheelSnapshot(page, clientX, clientY, before.graphPoint);
  assert.equal(zoomInDispatch.defaultPrevented, true);
  assert(zoomedIn.scale > before.scale);
  assert(Math.abs(zoomedIn.scale / before.scale - 1.08) < 0.005);
  assert(Math.hypot(zoomedIn.anchorError.x, zoomedIn.anchorError.y) <= 1);

  await dispatchGraphWheel(page, { clientX, clientY, deltaY: 100 });
  const zoomedOut = await graphWheelSnapshot(page, clientX, clientY);
  assert(zoomedOut.scale < zoomedIn.scale);
  assert(Math.abs(zoomedOut.scale - before.scale) < 0.001);

  const beforeOutsideWheel = zoomedOut.scale;
  await page.locator(".cm-content").dispatchEvent("wheel", {
    deltaX: 0,
    deltaY: -100,
    deltaMode: 0,
    bubbles: true,
    cancelable: true
  });
  assert.equal((await graphWheelSnapshot(page, clientX, clientY)).scale, beforeOutsideWheel);

  const graph = page.locator("#graph");
  await graph.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerId: 41,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true
  });
  const activeGestureDispatch = await dispatchGraphWheel(page, {
    clientX,
    clientY,
    deltaY: -100
  });
  assert.equal(activeGestureDispatch.defaultPrevented, false);
  assert.equal((await graphWheelSnapshot(page, clientX, clientY)).scale, beforeOutsideWheel);
  await graph.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    pointerId: 41,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true
  });

  for (let index = 0; index < 20; index += 1) {
    await dispatchGraphWheel(page, { clientX, clientY, deltaY: -10_000 });
  }
  assert(Math.abs((await graphWheelSnapshot(page, clientX, clientY)).scale - 2.2) < 1e-6);

  for (let index = 0; index < 30; index += 1) {
    await dispatchGraphWheel(page, { clientX, clientY, deltaY: 10_000 });
  }
  assert(Math.abs((await graphWheelSnapshot(page, clientX, clientY)).scale - 0.02) < 1e-6);

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
  assert.doesNotMatch(pastedRaw, /\nlevel:/);
  assert.match(pastedRaw, /parent: null/);
  assert.equal(await textContent(page, "#editorStatus"), "Pasted text as note");

  await page.close();
});

test("command z and command y undo and redo workspace note creation", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator("#newNoteButton").click();
  await page.locator("#newNoteTitle").fill("Undoable Note");
  await page.locator("#newNoteParent").selectOption("root.md");
  await page.locator("#newNoteForm button[type='submit']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "undoable-note.md");
  assert.match(await noteRaw(page, "undoable-note.md"), /title: "Undoable Note"/);

  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => !window.__apexTestState.workspace.notes.some(
    (note) => note.path === "undoable-note.md"
  ));
  assert.equal(await textContent(page, "#notePath"), "root.md");
  assert.equal(await textContent(page, "#editorStatus"), "Undid note creation");
  assert.equal(await page.locator(".node[data-path='undoable-note.md']").count(), 0);

  await pressShortcut(page, "Y");
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.some(
    (note) => note.path === "undoable-note.md"
  ));
  assert.match(await noteRaw(page, "undoable-note.md"), /parent: "\[\[root\]\]"/);
  assert.equal(await textContent(page, "#notePath"), "undoable-note.md");
  assert.equal(await textContent(page, "#editorStatus"), "Redid note creation");
  await assertGraphNode(page, "undoable-note.md");

  await page.close();
});

test("editor command z and command y undo and redo text edits", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator(".cm-content").click();
  await page.keyboard.type("\nUndo body line");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Undo body line"));

  await pressShortcut(page, "Z");
  await page.waitForFunction(() => !document.querySelector(".cm-content")?.textContent?.includes("Undo body line"));

  await pressShortcut(page, "Y");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Undo body line"));

  await page.close();
});

test("renaming a note updates body wiki links that point to it", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");

  await renameSelectedNoteTitle(page, "Renamed Child");
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.some(
    (note) => note.path === "root.md" && note.raw.includes("[[Renamed Child]]")
  ));

  assert.match(await noteRaw(page, "root.md"), /\[\[Renamed Child\]\]/);
  assert.doesNotMatch(await noteRaw(page, "root.md"), /\[\[child\]\]/);
  assert.equal(await textContent(page, "#editorStatus"), "Updated 1 wiki link");

  await page.close();
});

test("deleting a note removes wiki brackets from linked notes", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");
  await page.locator("#deleteNoteButton").click();
  await page.locator("#confirmDeleteButton").click();
  await page.waitForFunction(() => !window.__apexTestState.workspace.notes.some(
    (note) => note.path === "child.md"
  ));

  const rootRaw = await noteRaw(page, "root.md");
  assert.match(rootRaw, /This root links to child\./);
  assert.doesNotMatch(rootRaw, /\[\[child\]\]/);
  assert.equal(await page.locator(".node[data-path='child.md']").count(), 0);

  await page.close();
});

test("typing a missing wiki link in the editor creates a loose graph note", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTab.active").waitFor();

  await page.locator("#searchInput").fill("child");
  await page.locator("[data-search-result-path='child.md']").click();
  await page.waitForFunction(() => document.querySelector("#notePath")?.textContent === "child.md");
  await page.locator("#searchInput").fill("");

  await page.locator(".cm-content").click();
  await page.keyboard.type("\n[[New Linked Note]]");
  await page.waitForFunction(() => window.__apexTestState.workspace.notes.some(
    (note) => note.path === "new-linked-note.md"
  ));
  await page.waitForFunction(() => document.querySelector("#editorStatus")?.textContent === "Created 1 linked note");

  const childRaw = await noteRaw(page, "child.md");
  const linkedRaw = await noteRaw(page, "new-linked-note.md");
  assert.match(childRaw, /\[\[New Linked Note\]\]/);
  assert.match(linkedRaw, /title: "New Linked Note"/);
  assert.doesNotMatch(linkedRaw, /\nlevel:/);
  assert.match(linkedRaw, /parent: null/);
  assert.doesNotMatch(linkedRaw, /\n# New Linked Note\n/);
  assert.equal(await textContent(page, "#notePath"), "child.md");
  await assertGraphNode(page, "new-linked-note.md");
  const positions = await page.evaluate(() => window.__apexTestState.workspace.positions);
  assert(positions["child.md"]);
  assert(positions["new-linked-note.md"]);
  assert.equal(Math.round(positions["new-linked-note.md"].x - positions["child.md"].x), 168);
  assert.equal(Math.round(positions["new-linked-note.md"].y - positions["child.md"].y), 0);

  await page.close();
});

test("main-production update button appears and invokes native update install", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), {
    holdInstallUpdate: true,
    updateRelease: availableUpdateRelease()
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  const updateButton = page.getByRole("button", { name: /install apex notes update/i });
  await updateButton.waitFor();
  await updateButton.click();
  await page.waitForFunction(() => window.__apexTestState.resolveInstallUpdate);
  assert.equal(await textContent(page, "#updateButton"), "Updating...");

  const installCall = await page.waitForFunction(() => {
    return window.__apexTestState.calls.find((call) => call.command === "install_app_update");
  });
  const call = await installCall.jsonValue();
  assert.equal(call.args.releaseCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(Object.hasOwn(call.args, "downloadUrl"), false);

  await page.evaluate(() => window.__apexTestState.resolveInstallUpdate());
  await page.waitForFunction(() => document.querySelector("#updateButton")?.textContent?.includes("Restarting..."));
  assert.equal(await textContent(page, "#editorStatus"), "Restarting after update");
  await page.locator("#updateRestartOverlay").waitFor();
  assert.match(await textContent(page, "#updateRestartOverlay"), /Restarting to update\.\.\./);
  assert.match(await textContent(page, "#updateRestartOverlay"), /Apex Notes will reopen automatically\./);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "updateRestartOverlay");

  await page.close();
});

test("main-production update button stays hidden when no update is available", async () => {
  const page = await newMockedTauriPage();

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__apexTestState.fetchCalls > 0);

  assert.equal(await isVisible(page, "#updateButton"), false);

  await page.close();
});

test("main-production update checks rerun on focus and report install failures", async () => {
  const page = await newMockedTauriPage(sampleWorkspace(), {
    installUpdateError: "installer failed"
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__apexTestState.fetchCalls > 0);
  assert.equal(await isVisible(page, "#updateButton"), false);

  await page.evaluate((release) => {
    window.__apexTestState.updateRelease = release;
    window.dispatchEvent(new Event("focus"));
  }, availableUpdateRelease());

  const updateButton = page.getByRole("button", { name: /install apex notes update/i });
  await updateButton.waitFor();
  await page.waitForFunction(() => window.__apexTestState.fetchCalls > 1);
  await updateButton.click();
  await page.waitForFunction(() => document.querySelector("#editorStatus")?.textContent === "Update failed");

  assert.equal(await textContent(page, "#editorStatus"), "Update failed");
  assert.equal(await textContent(page, "#updateButton"), "Update");
  assert.equal(await updateButton.isDisabled(), false);

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
  assert.equal(await textContent(page, ".workspaceTab.active .workspaceTabTitle"), "Open new");
  assert.equal(await page.locator(".workspaceTab.active").getAttribute("aria-selected"), "true");

  await page.getByRole("button", { name: "Current folder: Smoke Notes" }).click();
  await page.waitForFunction(() => !document.body.classList.contains("projectChooserOpen"));
  assert.equal(await textContent(page, ".workspaceTab.active .workspaceTabTitle"), "Smoke Notes");

  await page.getByRole("button", { name: "Open another notes folder" }).click();
  await page.locator("#graphProjectLauncher").waitFor();
  await page.getByRole("button", { name: "Close open new tab" }).click();
  await page.waitForFunction(() => !document.body.classList.contains("projectChooserOpen"));
  assert.equal(await isVisible(page, ".editorPane"), true);
  assert.equal(await textContent(page, ".workspaceTab.active .workspaceTabTitle"), "Smoke Notes");

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

test("daily dates group lines across days and restore attribution with editor undo", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.clock.setFixedTime("2026-09-09T12:00:00Z");
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForFunction(() => window.__apexTestState.workspace.dates?.notes?.["root.md"]);
  assert.match(await page.locator("#noteDates").textContent(), /Created ≈ 1 Sep 2026 · Last edited 1 Sep 2026/);
  assert.equal(await page.locator(".cm-date-stamp").count(), 1);
  const dateAccessibility = await page.locator(".cm-date-stamp").ariaSnapshot();
  assert.match(dateAccessibility, /note.*1 Sep 2026/);
  assert.match(dateAccessibility, /estimated/i);
  assert.equal(await page.locator(".cm-date-stamp").getAttribute("tabindex"), null);
  await appendDateText(page, "\nToday one\nToday two");
  await waitForStoredDate(page, "2026-09-09");
  assert.equal(await page.locator(".cm-date-stamp").count(), 2);
  assert.equal(await page.locator(".cm-date-stamp[data-date-day='2026-09-09']").count(), 1);
  assert.match(await page.locator("#noteDates").textContent(), /Created ≈ 1 Sep 2026 · Last edited 9 Sep 2026/);

  await page.clock.setFixedTime("2026-09-10T12:00:00Z");
  await appendDateText(page, "\nTomorrow");
  await waitForStoredDate(page, "2026-09-10");
  assert.equal(await page.locator(".cm-date-stamp").count(), 3);
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => !document.querySelector(".cm-date-stamp[data-date-day='2026-09-10']"));
  assert.equal(await page.locator(".cm-date-stamp").count(), 2);
  await pressShortcut(page, "Y");
  await page.locator(".cm-date-stamp[data-date-day='2026-09-10']").waitFor();
  await appendDateText(page, `\n${"A long wrapped daily entry with ordinary words. ".repeat(10)}`);
  await page.waitForFunction(() => window.__apexTestState.workspace.notes[0].raw.includes("A long wrapped daily entry"));

  // Labels are decorations, not Markdown or text exported by CodeMirror copy.
  await pressShortcut(page, "A");
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    content.dispatchEvent(event);
    window.__dateCopiedText = event.clipboardData.getData("text/plain");
  });
  assert.match(await page.evaluate(() => window.__dateCopiedText), /First line/);
  assert.doesNotMatch(await page.evaluate(() => window.__dateCopiedText), /Sep 2026|≈/);
  assert.doesNotMatch(await noteRaw(page, "root.md"), /Sep 2026|≈|Written:|Added:/);
  assert.equal(await page.locator("#graph .cm-date-stamp").count(), 0);

  await page.setViewportSize({ width: 600, height: 700 });
  await page.locator("#fullscreenEditorButton").click();
  const bounds = await page.locator(".cm-date-stamp").evaluateAll((items) => items.map((item) => {
    const rect = item.getBoundingClientRect();
    const pane = item.closest(".editorPane").getBoundingClientRect();
    return { left: rect.left, right: rect.right, paneLeft: pane.left, paneRight: pane.right };
  }));
  assert(bounds.every((item) => item.left >= item.paneLeft && item.right <= item.paneRight));
  await page.close();
});

test("editing an older line splits its date group and reopening preserves it", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.clock.setFixedTime("2026-09-09T12:00:00Z");
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".cm-line").filter({ hasText: /^Second line$/ }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited");
  await waitForStoredDate(page, "2026-09-09");
  assert.equal(await page.locator(".cm-date-stamp").count(), 3);
  const saved = await page.evaluate(() => window.__apexTestState.workspace.dates);
  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.waitForFunction(() => window.__apexTestState.calls.filter((item) => item.command === "read_workspace").length === 2);
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.dates), saved);
  assert.equal(await page.locator(".cm-date-stamp").count(), 3);
  await page.close();
});

test("invalid or failing date metadata does not block Markdown saves", async () => {
  for (const corrupt of [false, true]) {
    const workspace = dateWorkspace();
    if (corrupt) workspace.datesError = "dates.json is invalid";
    const page = await newMockedTauriPage(workspace, { dateWriteError: corrupt ? "" : "Injected date failure" });
    await page.clock.setFixedTime("2026-09-09T12:00:00Z");
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open project" }).click();
    await appendDateText(page, "\nStill saved safely");
    await page.waitForFunction(() => window.__apexTestState.workspace.notes[0].raw.includes("Still saved safely"));
    await page.locator("#noteDatesWarning").waitFor();
    if (corrupt) assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((item) => item.command === "write_dates")), false);
    await page.close();
  }
});

test("external note edits retain unchanged dates and estimate changed lines", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForFunction(() => window.__apexTestState.workspace.dates?.notes?.["root.md"]);
  await page.evaluate(() => {
    const note = window.__apexTestState.workspace.notes[0];
    note.raw = note.raw.replace("Second line", "Second line from external editor");
    note.modifiedMs = Date.parse("2026-09-12T12:00:00Z");
  });
  await page.locator(".cm-date-stamp[data-date-day='2026-09-12']").waitFor();
  assert.equal(await page.locator(".cm-date-stamp[data-date-day='2026-09-12']").getAttribute("data-estimated"), "true");
  assert.equal(await page.locator(".cm-date-stamp[data-date-day='2026-09-01']").count(), 2);
  await page.close();
});

test("large external batches pause date tracking without replacing the sidecar", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForFunction(() => window.__apexTestState.workspace.dates?.notes?.["root.md"]);
  const before = await page.evaluate(() => JSON.stringify(window.__apexTestState.workspace.dates));
  await page.evaluate(() => {
    const state = window.__apexTestState;
    state.calls = [];
    state.workspace.notes.push(...Array.from({ length: 4 }, (_, index) => ({
      path: `external-${index}.md`,
      raw: `---\ntitle: "External ${index}"\nparent: null\n---\n\n${"text\n".repeat(67_000)}`,
      modifiedMs: Date.now()
    })));
  });
  await page.locator("#noteDatesWarning").waitFor();
  assert.match(await page.locator("#noteDatesWarning").textContent(), /200,000/);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__apexTestState.workspace.dates)), before);
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_dates")), false);
  await page.close();
});

test("readable Markdown links coexist with date labels and copy as Markdown", async () => {
  const workspace = dateWorkspace();
  workspace.notes[0].raw += "\n[Example](https://example.com/path)";
  const page = await newMockedTauriPage(workspace);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".cm-markdownLink").waitFor();
  assert.equal(await page.locator(".cm-date-stamp").count(), 1);
  await page.locator(".cm-markdownLink").click();
  await page.waitForFunction(() => window.__apexTestState.calls.some((call) => call.command === "plugin:opener|open_url" && call.args.url === "https://example.com/path"));
  await page.locator(".cm-content").focus();
  await pressShortcut(page, "A");
  const copied = await page.evaluate(() => {
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    document.querySelector(".cm-content").dispatchEvent(event);
    return event.clipboardData.getData("text/plain");
  });
  assert.match(copied, /\[Example\]\(https:\/\/example.com\/path\)/);
  assert.doesNotMatch(copied, /Sep 2026|≈/);
  await page.close();
});

function dateWorkspace() {
  const workspace = sampleWorkspace();
  workspace.notes = [{ path: "root.md", raw: '---\ntitle: "Dates"\nparent: null\n---\n\nFirst line\nSecond line\n\nThird line', createdMs: Date.parse("2026-09-01T12:00:00Z"), modifiedMs: Date.parse("2026-09-01T12:00:00Z") }];
  return workspace;
}

test("delayed date saves retain newer edits and stay with their originating tab", async () => {
  const second = dateWorkspace();
  second.rootPath = "/tmp/second-dated-workspace";
  second.notesPath = `${second.rootPath}/notes`;
  second.workspaceName = "Second dated workspace";
  const page = await newMockedTauriPage(dateWorkspace(), { additionalWorkspaces: [second] });
  await page.clock.setFixedTime("2026-09-09T12:00:00Z");
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.locator("[data-switch-workspace]").first().click();
  await page.waitForFunction(() => window.__apexTestState.workspaces[0].dates?.notes?.["root.md"]);
  await page.evaluate(() => { window.__apexTestState.holdDateWrites = true; });
  await appendDateText(page, "\nPending first day");
  await page.waitForFunction(() => window.__apexTestState.dateWriteResolvers.length === 1);
  await page.clock.setFixedTime("2026-09-10T12:00:00Z");
  await appendDateText(page, "\nNewer second day");
  await page.locator("[data-switch-workspace]").nth(1).click();
  await page.evaluate(() => {
    window.__apexTestState.holdDateWrites = false;
    window.__apexTestState.releaseDateWrite();
  });
  await page.waitForFunction(() => document.querySelector(".workspaceTab.active")?.textContent?.includes("Second dated workspace"));
  const stored = await page.evaluate(() => window.__apexTestState.workspaces[0]);
  assert.match(stored.notes[0].raw, /Pending first day\nNewer second day/);
  assert(stored.dates.notes["root.md"].lines.some((line) => line.day === "2026-09-09" && !line.estimated));
  assert(stored.dates.notes["root.md"].lines.some((line) => line.day === "2026-09-10" && !line.estimated));
  assert.doesNotMatch(await page.locator(".cm-content").textContent(), /Newer second day/);
  await page.locator("[data-switch-workspace]").first().click();
  await page.locator(".cm-date-stamp[data-date-day='2026-09-10']").waitFor();
  await page.close();
});

test("workspace undo restores date attribution and manual date markers remain unchanged", async () => {
  const workspace = dateWorkspace();
  workspace.notes[0].raw += "\n\n## Later section\n*Added: 2026-09-03*\nLater words";
  workspace.notes[0].raw = workspace.notes[0].raw.replace("First line", "*Written: 2026-08-25*\nFirst line");
  const page = await newMockedTauriPage(workspace);
  await page.clock.setFixedTime("2026-09-09T12:00:00Z");
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForFunction(() => window.__apexTestState.workspace.dates?.notes?.["root.md"]);
  const baseline = await page.evaluate(() => window.__apexTestState.workspace.dates.notes["root.md"]);
  assert.match(await page.locator("#noteDates").textContent(), /Created 25 Aug 2026/);
  await appendDateText(page, "\nAdded today");
  await waitForStoredDate(page, "2026-09-09");
  await page.locator("#graph").focus();
  await pressShortcut(page, "Z");
  await page.waitForFunction(() => !window.__apexTestState.workspace.notes[0].raw.includes("Added today"));
  await page.waitForFunction(() => !window.__apexTestState.workspace.dates.notes["root.md"].lines.some((line) => line.day === "2026-09-09"));
  assert.deepEqual(await page.evaluate(() => window.__apexTestState.workspace.dates.notes["root.md"]), baseline);
  assert.match(await noteRaw(page, "root.md"), /\*Written: 2026-08-25\*/);
  assert.match(await noteRaw(page, "root.md"), /\*Added: 2026-09-03\*/);
  await pressShortcut(page, "Y");
  await waitForStoredDate(page, "2026-09-09");
  await page.close();
});

async function appendDateText(page, text) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.insertText(text);
}

test("same-body workspace reopen discards old editor date history", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.clock.setFixedTime("2026-09-09T12:00:00Z");
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await appendDateText(page, "\nSaved edit");
  await waitForStoredDate(page, "2026-09-09");
  await page.evaluate(() => {
    const dates = window.__apexTestState.workspace.dates.notes["root.md"];
    dates.lines.forEach((line) => { line.day = "2026-09-08"; line.estimated = false; });
  });
  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.locator(".cm-date-stamp[data-date-day='2026-09-08']").waitFor();
  await page.locator(".cm-content").focus();
  await pressShortcut(page, "Z");
  assert.match(await page.locator(".cm-content").textContent(), /Saved edit/);
  assert.equal(await page.locator(".cm-date-stamp[data-date-day='2026-09-08']").count(), 1);
  await page.close();
});

test("workspace date capacity pauses metadata but leaves Markdown writable", async () => {
  const workspace = dateWorkspace();
  workspace.notes = Array.from({ length: 3 }, (_, index) => ({
    path: `large-${index}.md`,
    raw: `---\ntitle: "Large ${index}"\nparent: null\n---\n\n${"text\n".repeat(67_000)}`,
    createdMs: Date.parse("2026-09-01T12:00:00Z"),
    modifiedMs: Date.parse("2026-09-01T12:00:00Z")
  }));
  const page = await newMockedTauriPage(workspace);
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.locator("#noteDatesWarning").waitFor();
  assert.match(await page.locator("#noteDatesWarning").textContent(), /200,000/);
  assert.equal(await page.locator(".cm-date-stamp").count(), 0);
  await appendDateText(page, "Still writable");
  await page.waitForFunction(() => window.__apexTestState.workspace.notes[0].raw.includes("Still writable"));
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_dates")), false);
  await page.close();
});

test("oversized reopened note preserves its previously recorded date sidecar", async () => {
  const page = await newMockedTauriPage(dateWorkspace());
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open project" }).click();
  await page.waitForFunction(() => window.__apexTestState.workspace.dates?.notes?.["root.md"]);
  const before = await page.evaluate(() => JSON.stringify(window.__apexTestState.workspace.dates));
  await page.evaluate(() => {
    const state = window.__apexTestState;
    state.workspace.notes[0].raw += "\ntext".repeat(100_001);
    state.calls = [];
  });
  await page.locator(".workspaceTabAdd").click();
  await page.locator("#graphOpenProjectButton").click();
  await page.locator("#noteDatesWarning").waitFor();
  assert.match(await page.locator("#noteDatesWarning").textContent(), /preserved/);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__apexTestState.workspace.dates)), before);
  assert.equal(await page.evaluate(() => window.__apexTestState.calls.some((call) => call.command === "write_dates")), false);
  await page.close();
});

async function waitForStoredDate(page, day) {
  await page.waitForFunction((day) => window.__apexTestState.workspace.dates?.notes?.["root.md"]?.lines.some((line) => line.day === day && !line.estimated), day);
}

async function newMockedTauriPage(workspace = sampleWorkspace(), options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(({
    seedWorkspace,
    seedWorkspaces,
    seedUpdateRelease,
    seedHoldInstallUpdate,
    seedInstallUpdateError,
    seedHoldAnnotationWrites,
    seedAnnotationWriteFailures,
    seedHoldRenameWorkspace,
    seedDateWriteError
  }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const state = {
      workspace: clone(seedWorkspace),
      workspaces: clone(seedWorkspaces),
      dialogIndex: 0,
      calls: [],
      clipboardText: "",
      fetchCalls: 0,
      holdInstallUpdate: seedHoldInstallUpdate,
      installUpdateError: seedInstallUpdateError,
      resolveInstallUpdate: null,
      holdAnnotationWrites: seedHoldAnnotationWrites,
      annotationWriteResolvers: [],
      annotationWriteFailures: [...seedAnnotationWriteFailures],
      holdRenameWorkspace: seedHoldRenameWorkspace,
      renameWorkspaceResolvers: [],
      updateRelease: seedUpdateRelease
    };
    state.dateWriteError = seedDateWriteError;
    state.holdDateWrites = false;
    state.dateWriteResolvers = [];
    state.releaseDateWrite = () => state.dateWriteResolvers.shift()?.();
    state.releaseAnnotationWrite = () => state.annotationWriteResolvers.shift()?.();
    state.releaseRenameWorkspace = () => state.renameWorkspaceResolvers.shift()?.();

    const signatureFor = (note) => `${note.path}:${note.raw.length}`;
    const noteFiles = () => state.workspace.notes.map((note) => ({
      path: note.path,
      raw: note.raw,
      createdMs: note.createdMs,
      modifiedMs: note.modifiedMs || 1,
      byteLen: note.raw.length,
      signature: signatureFor(note)
    }));

    window.__apexTestState = state;
    window.fetch = async () => {
      state.fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => clone(state.updateRelease)
      };
    };
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
        open: async () => {
          const selected = state.workspaces[Math.min(state.dialogIndex, state.workspaces.length - 1)];
          state.dialogIndex += 1;
          return selected.rootPath;
        }
      },
      core: {
        invoke: async (command, args = {}) => {
          state.calls.push({ command, args: clone(args) });

          if (command === "read_recent_projects") return [];
          if (command === "default_project_location") return "/tmp";
          if (command === "read_workspace") {
            const selected = state.workspaces.find((item) => item.rootPath === args.rootPath) || state.workspace;
            state.workspace = selected;
            return clone(selected);
          }
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
            const target = state.workspaces.find((item) => item.notesPath === args.notesPath) || state.workspace;
            let note = target.notes.find((item) => item.path === args.path);
            if (!note) {
              note = { path: args.path, raw: "" };
              target.notes.push(note);
            }
            if (note.raw !== args.raw) note.modifiedMs = Date.now();
            note.raw = args.raw;
            return null;
          }
          if (command === "write_dates") {
            const target = state.workspaces.find((item) => item.notesPath === args.notesPath) || state.workspace;
            if (state.holdDateWrites) await new Promise((resolve) => state.dateWriteResolvers.push(resolve));
            if (state.dateWriteError || target.datesError) throw new Error(state.dateWriteError || target.datesError);
            target.dates = clone(args.dates);
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
            const next = { ...(state.workspace.positions || {}) };
            const updates = args.updates || args.patch || {};
            for (const [path, position] of Object.entries(updates)) {
              if (position === null) {
                delete next[path];
              } else {
                next[path] = position;
              }
            }
            state.workspace.positions = next;
            return null;
          }
          if (command === "write_annotations") {
            const target = state.workspaces.find((item) => item.notesPath === args.notesPath) || state.workspace;
            if (state.holdAnnotationWrites) {
              await new Promise((resolve) => state.annotationWriteResolvers.push(resolve));
            }
            if (state.annotationWriteFailures.shift()) {
              throw new Error("Injected annotation write failure");
            }
            target.annotations = clone(args.annotations);
            target.annotationsError = "";
            return null;
          }
          if (command === "rename_workspace") {
            if (state.holdRenameWorkspace) {
              await new Promise((resolve) => state.renameWorkspaceResolvers.push(resolve));
            }
            state.workspace.workspaceName = args.folderName;
            state.workspace.rootPath = `/tmp/${args.folderName}`;
            state.workspace.notesPath = `${state.workspace.rootPath}/notes`;
            return clone(state.workspace);
          }
          if (command === "remember_recent_project" || command === "forget_recent_project") return [];
          if (command === "install_app_update") {
            if (state.installUpdateError) throw new Error(state.installUpdateError);
            if (state.holdInstallUpdate) {
              await new Promise((resolve) => {
                state.resolveInstallUpdate = resolve;
              });
            }
            return null;
          }

          if (command === "plugin:opener|open_url") return null;
          throw new Error(`Unhandled test Tauri command: ${command}`);
        }
      }
    };
    window.__TAURI_INTERNALS__ = { invoke: window.__TAURI__.core.invoke };
  }, {
    seedHoldInstallUpdate: options.holdInstallUpdate || false,
    seedHoldAnnotationWrites: options.holdAnnotationWrites || false,
    seedAnnotationWriteFailures: options.annotationWriteFailures || [],
    seedHoldRenameWorkspace: options.holdRenameWorkspace || false,
    seedDateWriteError: options.dateWriteError || "",
    seedInstallUpdateError: options.installUpdateError || "",
    seedWorkspace: workspace,
    seedWorkspaces: [workspace, ...(options.additionalWorkspaces || [])],
    seedUpdateRelease: options.updateRelease || { target_commitish: "", assets: [] }
  });
  return page;
}

function availableUpdateRelease(commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
  return {
    target_commitish: commit,
    assets: [
      {
        name: "apex-notes-main-macos-arm64.dmg",
        browser_download_url: mainProductionDmgUrl
      }
    ]
  };
}

function sampleWorkspace() {
  return {
    rootPath: "/tmp/smoke-notes",
    notesPath: "/tmp/smoke-notes/notes",
    workspaceName: "Smoke Notes",
    source: "folder",
    positions: {},
    annotations: { version: 1, items: [] },
    annotationsError: "",
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
          "level: 99",
          'parent: "[[root]]"',
          "---",
          "",
          "# Child",
          "",
          "A child note with [Waymo for Business](https://waymo.com/business/).",
          "An [Unsafe](javascript:alert(1)) target stays plain Markdown."
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

async function pressShortcut(page, key) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+${key.toUpperCase()}`);
}

async function assertGraphNode(page, path) {
  const node = page.locator(`.node[data-path='${path}']`);
  await node.waitFor();
  assert.equal(await node.count(), 1);
}

async function dispatchGraphWheel(page, { clientX, clientY, deltaX = 0, deltaY, deltaMode = 0 }) {
  return page.locator("#graph").evaluate((element, init) => {
    const event = new WheelEvent("wheel", {
      ...init,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  }, { clientX, clientY, deltaX, deltaY, deltaMode });
}

async function graphWheelSnapshot(page, clientX, clientY, graphPoint = null) {
  return page.locator(".graphCanvas").evaluate((canvas, input) => {
    const screenMatrix = canvas.getScreenCTM();
    const localMatrix = canvas.transform.baseVal.consolidate()?.matrix;
    if (!screenMatrix || !localMatrix) throw new Error("Graph transform is unavailable");
    const point = input.graphPoint || new DOMPoint(input.clientX, input.clientY)
      .matrixTransform(screenMatrix.inverse());
    const anchoredScreenPoint = new DOMPoint(point.x, point.y).matrixTransform(screenMatrix);
    return {
      scale: localMatrix.a,
      graphPoint: { x: point.x, y: point.y },
      anchorError: {
        x: anchoredScreenPoint.x - input.clientX,
        y: anchoredScreenPoint.y - input.clientY
      }
    };
  }, { clientX, clientY, graphPoint });
}

async function noteRaw(page, path) {
  return page.evaluate((notePath) => {
    const note = window.__apexTestState.workspace.notes.find((item) => item.path === notePath);
    return note?.raw || "";
  }, path);
}

async function renameSelectedNoteTitle(page, title) {
  await page.locator("#noteTitle").evaluate((element, nextTitle) => {
    element.focus();
    element.textContent = nextTitle;
    element.dispatchEvent(new Event("blur"));
  }, title);
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
