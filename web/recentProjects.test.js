import assert from "node:assert/strict";
import test from "node:test";

import {
  RECENT_PROJECT_LIMIT,
  loadRecentProjects,
  projectDisplayPath,
  projectLocationFromPath,
  projectNameFromPath,
  projectParentFromPath,
  rememberRecentProject,
  removeRecentProject,
  saveRecentProjects
} from "./recentProjects.js";

test("remembers projects newest first and dedupes by root path", () => {
  const projects = rememberRecentProject(
    { rootPath: "/Users/boris/apex-notes", name: "Apex Notes" },
    [{ rootPath: "/Users/boris/old", name: "Old", lastOpenedAt: 10 }],
    20
  );
  const updated = rememberRecentProject(
    { rootPath: "/Users/boris/old", name: "Old Renamed" },
    projects,
    30
  );

  assert.deepEqual(
    updated.map((project) => [project.rootPath, project.name, project.lastOpenedAt]),
    [
      ["/Users/boris/old", "Old Renamed", 30],
      ["/Users/boris/apex-notes", "Apex Notes", 20]
    ]
  );
});

test("limits stored recents", () => {
  let projects = [];
  for (let index = 0; index < RECENT_PROJECT_LIMIT + 4; index += 1) {
    projects = rememberRecentProject(
      { rootPath: `/tmp/project-${index}`, name: `Project ${index}` },
      projects,
      index
    );
  }

  assert.equal(projects.length, RECENT_PROJECT_LIMIT);
  assert.equal(projects[0].name, `Project ${RECENT_PROJECT_LIMIT + 3}`);
});

test("loads and saves through storage without throwing on malformed data", () => {
  const storage = memoryStorage();
  storage.setItem("apex-notes-recent-projects-v1", "{nope");

  assert.deepEqual(loadRecentProjects(storage), []);

  saveRecentProjects([{ rootPath: "/tmp/apex", name: "Apex", lastOpenedAt: 5 }], storage);
  assert.deepEqual(loadRecentProjects(storage), [
    { rootPath: "/tmp/apex", name: "Apex", lastOpenedAt: 5 }
  ]);
});

test("formats recent project names and parent locations", () => {
  assert.equal(projectNameFromPath("/Users/boris/Documents/theplan"), "theplan");
  assert.equal(projectParentFromPath("/Users/boris/Documents/theplan"), "/Users/boris/Documents");
  assert.equal(projectDisplayPath("/Users/boris/Documents"), "~/Documents");
  assert.equal(projectLocationFromPath("/Users/boris/Documents/theplan"), "~/Documents");
  assert.equal(projectLocationFromPath("/workspace"), "/");
  assert.equal(projectLocationFromPath("/"), "/");
});

test("removes stale recent projects", () => {
  const projects = [
    { rootPath: "/tmp/a", name: "A", lastOpenedAt: 2 },
    { rootPath: "/tmp/b", name: "B", lastOpenedAt: 1 }
  ];

  assert.deepEqual(removeRecentProject("/tmp/a", projects), [
    { rootPath: "/tmp/b", name: "B", lastOpenedAt: 1 }
  ]);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}
