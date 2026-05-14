---
name: apex-notes-writing
description: Use when creating, editing, tagging, or connecting notes for Apex Notes, a Markdown hierarchy app that stores notes under notes/. Enforces required frontmatter, unbounded depth levels, single-parent hierarchy, contextual dotted reference links, manifest updates, and the rule that body links are not hierarchy.
---

# Apex Notes Writing

## Scope

Use this skill whenever writing or changing Markdown notes in a `notes/` folder managed by this app.

The source of truth is the Markdown files in `notes/`. The app derives the graph from each note's frontmatter.

## Required Frontmatter

Every note must start with exactly one YAML frontmatter block using this shape:

```yaml
---
title: "Human Readable Title"
level: 0
parent: null
---
```

Level semantics:

- `0` is the apex.
- Any non-apex note has level `parent.level + 1`.
- Levels are unbounded depth numbers. Do not assign names to levels beyond the apex.

Do not add schema fields beyond `title`, `level`, and `parent` unless the user explicitly changes the schema.

## Canonical Connection Rule

`parent` is the only canonical hierarchy edge.

- Use `parent: null` only on the single level `0` apex note.
- Every non-apex note must have exactly one `parent`.
- The parent must be one level above the child.
- Use a wiki link to the parent file stem, preserving the existing style:

```yaml
parent: "[[parent-note]]"
```

Body links are only contextual references. Never rely on body links to define hierarchy.

## Contextual Reference Links

Create dotted, non-hierarchy connections by adding wiki links in the note body:

```md
This depends on [[related-note]] and also touches [[another-note|a readable label]].
```

Rules:

- Use body links to tag or reference other existing nodes that are contextually related.
- Link by file stem, title, slug, or path when it resolves clearly to one note.
- Use aliases with `[[target-note|label]]` when the sentence should read naturally.
- Do not use a body link instead of `parent`; hierarchy still belongs only in frontmatter.
- Do not add body links to every ancestor. Add them only when the body text is genuinely about that other node.

The app renders resolved body links as dotted reference lines between nodes. Broken links stay visible in the editor as missing links and do not create a graph edge.

## Placement Rules

- Preserve existing filenames when editing existing notes.
- For new notes, choose a stable filename. The visible graph label comes from `title`.
- Subfolders are allowed, but folder names do not define hierarchy; `parent` does.

Place each new note under the immediate parent that best represents where it belongs. Do not create category names or intermediate levels unless the user's graph actually needs those nodes.

## Writing Workflow

Before editing:

1. Read the relevant existing parent note.
2. Verify the intended parent exists and is exactly one level above the new or edited note.
3. Set the level to `parent.level + 1`, or `0` for the apex.

When adding a note:

1. Put it in the correct folder.
2. Add the required frontmatter first.
3. Set `parent` to the immediate parent.
4. Write concise body text with an H1 matching the title when useful.
5. Add body links only for contextual references.
6. Update `notes/manifest.json` with the new path relative to `notes/`.

When deleting a note:

1. Remove it from `notes/manifest.json`.
2. Check for children that use it as `parent` and re-parent them only if the user asked for that structural change.

When editing a note:

- Keep the filename stable unless the user explicitly wants a rename.
- Do not change `level` or `parent` casually; that is a graph structure change.
- If you do change structure, verify the parent level rule still holds.

## Examples

Child under an apex:

```yaml
---
title: "Example Child"
level: 1
parent: "[[apex]]"
---
```

Deeper child:

```yaml
---
title: "Example Deeper Child"
level: 2
parent: "[[example-child]]"
---
```

## Final Check

Before finishing, confirm:

- All edited notes have valid frontmatter.
- Each non-apex note has one immediate parent.
- No body link is being used as the hierarchy edge.
- `notes/manifest.json` changed only if note files were added or deleted.
and verify:

Build the hierarchy from frontmatter only, then verify and repair manifest connectivity.  
Requirements:
1) One and only one apex: exactly one note with `level: 0` and `parent: null`.  
2) Every other note: single `parent` in format `[[file-stem]]`, and its parent must be an existing note with `level = child.level - 1`.  
3) Make all parent/level relationships valid and canonical; use body wiki links only as contextual references, never hierarchy.  
4) If any `manifest.json` entry references a missing file, remove it (or add the file if creating new notes).  
5) Before finishing, report a validation check with counts: total notes, #roots, #notes with valid parent chain, #manifest missing entries, and explicit list of fixes made.  

