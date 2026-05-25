---
name: apex-notes-writing
description: use skill when writing .md for Apex Notes; create/edit/import/delete/connect notes; enforce title/level/parent frontmatter, parent-only hierarchy, body wikilink refs, manifest sync.
---

# Apex Notes Writing

Use skill when writing/changing Apex Notes `.md`.

Repo rule: bundled `notes/` = neutral sample data only. No private/user notes in app repo.

## App Contract

- Workspace: app opens folder; if `notes/` exists, note root = `notes/`; else opened folder = note root.
- Reads `.md` recursively under note root; ignores dotfiles/symlinks.
- Source of truth after folder access = actual `.md`; `manifest.json` = seed/metadata path list.
- `layout.json` = graph positions keyed by note path; not hierarchy.
- New app-created workspace starts with empty `notes/manifest.json` + `notes/layout.json`.

## Frontmatter

Every note starts with only:

```yaml
---
title: "Human Readable Title"
level: 0
parent: null
---
```

Rules:
- keys: only `title`, `level`, `parent`; no schema fields unless schema task.
- `title` = graph label; filename is storage.
- `level` = cached derived depth; integer; unbounded; no names for levels.
- `parent: null` = loose note or independent root; level must be `0`.
- `parent: "[[parent-stem]]"` = one immediate parent; child level = parent level + 1.
- Parent must exist, resolve uniquely, be outside child descendant chain.
- Multiple roots/loose notes in one folder are valid.

## Links

- Hierarchy edge: frontmatter `parent` only.
- Body `[[wikilink]]` = contextual/reference edge only.
- Body link forms: `[[stem]]`, `[[path/stem]]`, `[[Title]]`, `[[target|label]]`.
- Prefer parent/body refs by stable file stem; app also resolves path, title, slug.
- Do not body-link every ancestor; link only real context.
- Do not use body links to fake hierarchy.

## Files

- Preserve existing filenames unless rename requested.
- New filename: stable slug `.md`; unique; subfolders OK.
- Folder names never define hierarchy; `parent` does.
- Keep body concise; H1 matching title is OK, not hierarchy.
- Imports/pastes should choose/require parent when making connected children; otherwise use `parent: null`.

## Manifest/Layout

- On add/delete `.md`, update `manifest.json`.
- Manifest = sorted JSON array of `.md` paths relative to note root.
- Manifest lists Markdown only; no `layout.json`, media, dirs, non-md.
- If deleting/renaming and touching `layout.json`, remove/rename stale keys only; do not invent hierarchy there.
- Opened folders can still load files not in manifest, but seed preview needs manifest parity.

## Edits

- Before edit: read current note set + manifest; detect existing hierarchy.
- Connect/reparent: change child `parent`; set child/descendant levels from parent chain.
- Level mismatch alone: repair `level`; do not reparent.
- Delete parent: children may keep broken parents unless user asks reparent.
- Avoid duplicate titles/aliases; duplicate aliases make refs ambiguous.
- Keep unknown/private content out of repo sample notes.

## Validate

Before done:
- all notes: frontmatter present; only 3 keys; title present; level valid.
- parents: null or exactly one `[[...]]`; resolves uniquely; no missing parent; no cycles.
- connected notes: declared level == derived depth; parent exactly one level above.
- body links: references only; no hierarchy encoded in body text.
- manifest: missing/extra paths fixed; all paths `.md`, relative, sorted.
- layout: no stale path keys if edited.

Report compactly: `notes=N parentless=N connected=N manifest_missing=N manifest_extra=N fixes=[...]`.
