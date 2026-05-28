# UI-Created Project Validity Hardening Plan

## Purpose

Apex Notes should allow users to play directly in the graph without learning the Markdown storage contract first. If a project was created or changed only through the app UI, reopening that same project should not produce a formatting warning unless the files were changed outside the app.

This plan separates the immediate `vivalafrance` failure from the broader product invariant:

- UI actions must write canonical note files.
- UI actions must write resolvable graph references.
- UI validation must distinguish malformed project data from merely ambiguous or inconvenient display choices.
- Recovery flows must repair app-created inconsistencies instead of asking the user to become the schema validator.

## Current Contract

Each note is a Markdown file with exactly this frontmatter shape:

```yaml
---
title: "Human Readable Title"
parent: null
---
```

The canonical hierarchy edge is `parent`; graph depth is derived at runtime from the parent chain. Body wiki links are contextual references only. A valid UI-created project may contain:

- More than one root or loose note with `parent: null`.
- Duplicate display titles.
- Multiple independent hierarchies.
- Deep hierarchies beyond any named category system.

A valid UI-created project must not contain:

- Missing frontmatter.
- Missing `title` or `parent`.
- Extra app schema fields added by the app.
- A parent reference that cannot resolve to a note.
- A parent reference that points to a descendant and creates a cycle.
- A `manifest.json` that omits files the app created or includes files the app deleted.

Legacy `level` frontmatter is ignored and may be removed the next time a note is rewritten.

## Part 1: What Happened In `vivalafrance`

The project contained these relevant files:

```text
branch.md       title: "Branch"  parent: [[new-apex]]
branch-2.md     title: "Branch"  parent: [[hey]]
branch-3.md     title: "Branchi" parent: [[branch-2]] body: [[branch]]
```

The user dragged from `branch-3.md` to `branch.md`. The app appended this body link:

```markdown
[[branch]]
```

That write succeeded, so the editor showed the in-text wiki link. The reference edge did not appear because graph resolution had two conflicting ideas:

1. `[[branch]]` was intended by the UI as the stable file stem for `branch.md`.
2. The alias index also saw `branch` as a duplicate alias because `branch-2.md` had the display title `Branch`.

Because duplicate aliases were excluded from normal alias resolution, `[[branch]]` resolved to nothing. No reference edge was created, so the semi-transparent contextual line did not render.

Reopening the project then showed a formatting warning because duplicate titles were treated as invalid project format. That was the wrong product rule. Duplicate titles can be confusing, but they are allowed by the note contract because `title` is display text, not identity.

## Immediate Fix

The immediate patch should keep the app's existing write format but make the resolver honor file identity first:

1. Exact stored path wins.
2. Exact Markdown file stem wins.
3. Unique alias wins.
4. Ambiguous aliases remain unresolved unless the user or UI supplies a file-stem/path reference.

With that rule, `[[branch]]` resolves to `branch.md` even when another note has `title: "Branch"`.

The patch also stops duplicate display titles from counting as project validity errors. Duplicate alias metadata can remain available for future UI warnings or autocomplete disambiguation, but it should not make an app-created project invalid.

## Regression Coverage

Add a graph-model regression using the `vivalafrance` shape:

- `branch.md` and `branch-2.md` both have `title: "Branch"`.
- `branch-3.md` links to `[[branch]]`.
- The graph index resolves that body ref to `branch.md`.
- The graph index keeps `branch-3.md` parented to `branch-2.md`.
- The graph index reports no validity errors.

This catches both visible symptoms:

- The semi-transparent reference edge exists.
- Reopening the project does not warn purely because duplicate display titles exist.

## Part 2: Make UI-Created Invalid Projects Impossible

### Principle: One Writer, One Schema

Today note writes are composed in multiple flows:

- New note form.
- Graph empty-space note creation.
- Info panel autosave.
- Drag-to-parent connection.
- Drag-to-reference connection.
- Paste/copy flows.
- Delete and manifest update flows.
- Workspace bootstrap.

These flows should share a single note writer API in the frontend before crossing the Tauri boundary. The API should accept semantic operations and produce complete canonical files:

```js
createNote({ title, parentPath, body, position })
updateNoteMetadata({ path, title, parentPath })
setParent({ childPath, parentPath })
addReference({ sourcePath, targetPath })
deleteNotes({ paths })
```

No UI flow should hand-roll frontmatter strings or wiki refs after this consolidation.

### Principle: Paths Are Identity, Titles Are Labels

Internal app state should always use paths for note identity. Titles should never be used to decide which note a UI action targets.

Required rules:

- Graph node data attributes should use note paths.
- Drag interactions should carry source and target paths.
- Parent dropdown values should be paths.
- Reference insertion should derive a stable wiki ref from the target path.
- Rename/title edits should update only display text unless the user explicitly renames the file in a future feature.

### Canonical Wiki Ref Formatting

Add one helper for every app-written wiki reference:

```js
wikiRefForPath(path)
```

Initial behavior:

- Strip only the `.md` extension.
- Preserve subfolders when present.
- Never use the title for persisted refs.

Examples:

```text
branch.md -> [[branch]]
Projects/Branch.md -> [[Projects/Branch]]
branch-2.md -> [[branch-2]]
```

This matches the current file-stem convention while keeping enough identity to resolve duplicate titles.

### Preflight Every UI Mutation

Before writing files, every UI mutation should create an in-memory preview of the changed workspace and run a fast validation pass.

Preflight should reject:

- Missing required frontmatter.
- Parent cycles.
- Parent references that cannot resolve.
- Manifest drift after create/delete.
- Empty titles after trimming.
- Writes to a path outside the active notes folder.

Preflight should allow:

- Duplicate titles.
- Multiple roots.
- Loose notes.
- Body references that are ambiguous only because the user typed them manually.

For drag operations, preflight must run before `write_note`. If preflight fails, the UI should keep the graph unchanged and show a plain-language status message.

### Post-Write Verification

After a native write returns, the app should re-read or re-parse the written raw content and confirm that the resulting workspace still matches the preflight result.

For single-note writes:

- Parse the written raw content.
- Rebuild the graph index in memory.
- Confirm the intended edge or title change exists.
- Only then update visible state.

For multi-note writes:

- Apply all parsed writes to a cloned workspace state.
- Rebuild once.
- Confirm all intended parent edges exist.
- Update visible state atomically.

If verification fails, the app should show a recoverable error and leave the previous visible graph state in place.

### Native-Side Guardrail

Frontend validation protects user experience, but the Tauri backend should also reject malformed app writes. Add a strict command or validation mode around app-originated writes:

```rust
write_note_checked(notes_path, path, raw, expected_manifest_delta)
```

The backend should verify:

- The path is a Markdown file under the active notes folder.
- Frontmatter parses into exactly `title` and `parent` for app-created files.
- `title` is present and non-empty.
- `parent` is `null` or a wiki ref string.

The backend cannot always validate the full graph cheaply for one write unless it reads sibling notes, but it can prevent malformed raw files from being written by the UI.

### Manifest Transaction Safety

Create/delete flows should treat note files and `manifest.json` as one logical transaction:

- Create note file.
- Update manifest.
- Re-read manifest.
- If manifest write fails, show a repair prompt and keep the created note visible as unsynced.

Delete flow should:

- Trash note files.
- Update manifest.
- Preserve layout cleanup in the same operation group.

Add a small `verifyManifestCoverage(notes, manifest)` helper and use it after every create/delete/paste flow.

### Validation Categories

Split validation into three categories:

1. `invalid`: The project violates the Apex Notes storage contract.
2. `warning`: The project is valid but may be confusing.
3. `info`: The project is valid and the app is explaining a mode, such as grid mode.

Examples:

```text
invalid: missing parent, cycle, missing title
warning: duplicate display titles, ambiguous manually typed body ref
info: multiple roots, loose notes, grid layout
```

The app should only show "not correctly formatted" for `invalid`.

### UI Recovery

When invalid data is detected, offer targeted repairs instead of only showing the agent prompt:

- Missing frontmatter: "Repair note format"
- Missing title: "Use filename as title"
- Missing parent target: "Detach as loose note" or "Choose parent"
- Manifest drift: "Rebuild manifest"

The agent prompt remains useful for large imported folders, but app-created inconsistencies should have one-click repair paths.

### Required Tests

Add unit tests for:

- `wikiRefForPath`.
- Path-stem resolution before alias resolution.
- Duplicate titles produce warnings, not invalid errors.
- Parent cycle preflight rejection.
- Depth derivation when connecting a loose note to a parent.
- Manifest coverage after create/delete.

Add e2e tests for:

- Create two notes with the same title, connect them by body reference, reopen, and verify no invalid-format warning.
- Drag a loose root under another node and verify parent is written correctly.
- Rename a node to a duplicate title and verify the graph remains valid.
- Delete a parent and verify children are not silently rewritten into malformed state.
- Paste a copied subgraph and verify all parent refs point to new paths.

### Acceptance Criteria

This hardening is complete when:

- A user can create duplicate display titles through the UI without invalidating the project.
- Every drag-created reference edge renders immediately and after reopen.
- Every drag-created hierarchy edge writes a resolvable `parent` ref.
- Reopening a project created only through the UI never shows an invalid-format warning.
- The test suite includes the `vivalafrance` regression and at least one full UI reopen workflow.
