# Supporting Media In Apex Notes

Apex Notes can launch without media support. The core product is a local-first Markdown hierarchy tool: Markdown notes are graph nodes, frontmatter defines hierarchy, and body links add contextual references. Media support should preserve that model instead of becoming a second graph or schema layer.

This plan is based on Obsidian's attachment model:

- Attachments are regular files inside the vault.
- Pasted or dropped files are copied into a configured attachment location.
- Notes embed media with Markdown or Obsidian-style embed syntax.
- Images, audio, video, and PDFs can be embedded, but the files remain normal files on disk.

References:

- Obsidian attachments: https://obsidian.md/help/attachments
- Obsidian embeds: https://obsidian.md/help/embeds
- Obsidian accepted file formats: https://obsidian.md/help/file-formats

For Apex Notes, the first release should be image-only, local-only, and conservative. It should make images useful inside notes while leaving hierarchy, manifests, and graph behavior unchanged.

## Product Principles

Media support should follow these principles:

- Notes remain Markdown files.
- Media files are attachments, not notes.
- Media files do not become graph nodes.
- Media references do not define hierarchy.
- `parent` frontmatter remains the only canonical hierarchy edge.
- Body links to notes remain contextual graph references.
- Body embeds to media remain note content only.
- The app should never upload, download, or fetch media unless the user explicitly asks for that behavior in a future feature.

## Current App Constraints

The current app intentionally treats Markdown notes as the main content surface.

Important existing constraints to preserve:

- Note files are `.md` files.
- `manifest.json` lists Markdown note paths only.
- `layout.json` stores graph positions keyed by note path.
- Frontmatter uses only `title`, `level`, and `parent`.
- Graph hierarchy is derived from `parent`.
- Dotted contextual graph edges are derived from body wiki links to notes.
- Native filesystem commands already guard against traversal and symlink escapes for note paths.

Media support should add a separate attachment path, not loosen the note path rules.

## V1: Image-Only Support

### Goal

Let users paste, drop, and embed local images in Markdown notes.

The v1 user experience:

1. The user opens a writable Apex Notes folder.
2. The user selects a note.
3. The user pastes or drops an image into the editor.
4. Apex Notes stores the image under `attachments/`.
5. Apex Notes inserts a Markdown embed at the cursor.
6. The editor renders the image inline.
7. Reopening the workspace keeps the image visible.

### Non-Goals

Do not include these in image v1:

- Audio support.
- Video support.
- PDF support.
- Arbitrary file attachments.
- Attachment browser.
- Attachment rename UI.
- Attachment delete UI.
- Unused attachment cleanup.
- Image OCR.
- Image search by visual content.
- Remote image download.
- Remote image preview.
- Graph nodes for images.
- Frontmatter media fields.
- Media entries in `manifest.json`.
- Rich Markdown preview mode.

### Storage Model

Images should be regular files inside the opened notes folder.

Default location:

```text
attachments/
```

Example workspace:

```text
notes/
  manifest.json
  layout.json
  apex.md
  product-thinking.md
  attachments/
    diagram.png
    pasted-image-2026-05-21-001.jpg
```

The `attachments/` folder should be created lazily when the first image is pasted, dropped, or explicitly attached.

Do not require `attachments/` to exist for normal note folders.

Do not add `attachments/` to `manifest.json`.

Do not add attachment state to `layout.json`.

### Frontmatter Contract

Do not change frontmatter.

Every note should keep the existing shape:

```yaml
---
title: "Human Readable Title"
level: 0
parent: null
---
```

No new schema fields should be added for media.

Rejected examples:

```yaml
cover: attachments/image.png
attachments:
  - image.png
media: true
```

Image references belong in the Markdown body.

### Supported Image Formats

V1 should support common raster image formats:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.webp`
- `.avif`

Defer SVG in v1. SVG can contain active content and needs explicit security handling before it is treated as a safe inline image format.

### Supported Markdown Syntax

Support Obsidian-style image embeds:

```md
![[attachments/diagram.png]]
![[attachments/diagram.png|300]]
![[attachments/diagram.png|640x480]]
```

Support standard Markdown image syntax:

```md
![Diagram](attachments/diagram.png)
```

Support relative paths inside the notes folder:

```md
![[attachments/diagram.png]]
![Diagram](attachments/diagram.png)
```

Do not support absolute filesystem paths:

```md
![[/Users/name/Desktop/image.png]]
![Diagram](/Users/name/Desktop/image.png)
```

Do not support traversal paths:

```md
![[../private/image.png]]
![Diagram](../private/image.png)
```

Remote URLs should remain plain Markdown text in v1. Do not fetch or render them automatically:

```md
![Remote](https://example.com/image.png)
```

### Sizing Rules

For Obsidian-style embeds, support the common size suffix:

```md
![[attachments/diagram.png|300]]
![[attachments/diagram.png|640x480]]
```

Rules:

- No size means render at natural size, constrained by the editor width.
- `|300` means width `300px` and height auto.
- `|640x480` means width `640px` and height `480px`.
- Width and height must be positive integers.
- Clamp rendered dimensions to a sensible editor maximum.
- Invalid sizes should be ignored.
- The source Markdown should remain unchanged when a size is invalid.

Standard Markdown image syntax should not get custom size parsing in v1. It should render constrained to the editor width.

### Path Resolution

Image paths should resolve relative to the notes folder.

Resolution examples:

```text
attachments/diagram.png
./attachments/diagram.png
```

Both can resolve to:

```text
notes/attachments/diagram.png
```

Validation rules:

- Path must be relative.
- Path must not be empty.
- Path must not contain `..`.
- Path must not escape the notes folder after canonicalization.
- Path must not include symlink escapes.
- Path must not point at a directory.
- Path extension must be a supported image extension.
- Hidden system files should be ignored.

Keep this validator separate from the existing Markdown note validator.

### Native Commands

Add native attachment commands instead of exposing a general file read API.

Suggested command:

```text
write_attachment(notesPath, suggestedName, bytes) -> AttachmentFile
```

Returned shape:

```ts
type AttachmentFile = {
  path: string;
  mimeType: string;
  byteLen: number;
  signature: string;
};
```

Behavior:

- Validate `notesPath` as an existing notes folder.
- Create `attachments/` if needed.
- Sanitize `suggestedName`.
- Preserve a safe extension when possible.
- Infer extension from MIME type when needed.
- Deduplicate filenames without overwriting existing files.
- Write only supported image types.
- Return the relative attachment path.

Deduplication example:

```text
image.png
image-2.png
image-3.png
```

Suggested command:

```text
read_attachment(notesPath, path) -> AttachmentFileData
```

Returned shape:

```ts
type AttachmentFileData = {
  path: string;
  mimeType: string;
  byteLen: number;
  signature: string;
  dataBase64: string;
};
```

Behavior:

- Validate the relative path with the attachment validator.
- Reject unsupported extensions.
- Reject missing files with a clear error.
- Reject files above the v1 image size limit.
- Return image bytes as base64 for inline rendering.

Base64 is acceptable for image v1. If Apex Notes later supports large videos or PDFs, switch to a more efficient local asset URL or streaming approach.

### Suggested Limits

Initial v1 limits:

- Maximum pasted or dropped image size: 15 MB.
- Maximum rendered image width: editor width.
- Maximum explicit width: 1600 px.
- Maximum explicit height: 1600 px.

If an image is larger than the supported limit, show a clear status message and do not write the file.

### Editor Rendering

Render images inline inside CodeMirror using widgets.

Rules:

- The Markdown source remains the canonical note content.
- Widgets are a visual editing affordance only.
- Do not convert Markdown to stored HTML.
- Do not mutate the note when an image fails to load.
- Render widgets only for supported local image paths.
- Keep the raw Markdown text available for editing.

Widget states:

- Loading.
- Rendered.
- Missing.
- Unsupported.
- Too large.
- Invalid path.

Rendered images should:

- Fit inside the editor column.
- Preserve aspect ratio unless explicit width and height are provided.
- Use subtle styling consistent with the app.
- Avoid layout jumps where practical.
- Never overlap neighboring text.

Missing placeholder example:

```text
Missing image: attachments/diagram.png
```

Unsupported placeholder example:

```text
Unsupported image type: attachments/vector.svg
```

### Editor Paste Flow

When a user pastes image data into the editor:

1. Confirm a writable workspace is open.
2. Confirm exactly one active note is selected.
3. Read image files from clipboard items.
4. Reject unsupported image types.
5. Generate a stable suggested filename.
6. Call `write_attachment`.
7. Insert an Obsidian-style embed at the cursor.
8. Mark the note dirty through the existing editor update path.
9. Let autosave persist the Markdown note.
10. Render the image widget after the note updates.

Suggested inserted syntax:

```md
![[attachments/pasted-image-2026-05-21-001.png]]
```

If multiple images are pasted, insert one embed per line in the clipboard order.

### Editor Drop Flow

When a user drops image files onto the editor:

1. Confirm a writable workspace is open.
2. Confirm exactly one active note is selected.
3. Stop the event from reaching graph-level Markdown import.
4. Filter dropped files to supported images.
5. Write each image through `write_attachment`.
6. Insert embeds at the drop cursor or current cursor.
7. Autosave normally.

Dropping images onto the graph should not create graph nodes in v1.

Dropping Markdown files onto the graph should keep the existing Markdown import behavior.

### Parser Requirements

Add a parser for image embeds that is separate from note reference parsing.

It should detect:

```md
![[attachments/example.png]]
![[attachments/example.png|300]]
![[attachments/example.png|640x480]]
![Alt](attachments/example.png)
```

It should return:

```ts
type ImageEmbed = {
  syntax: "wiki" | "markdown";
  from: number;
  to: number;
  path: string;
  alt: string;
  width: number | null;
  height: number | null;
};
```

It should not treat images as note refs.

That means this should not create a dotted graph edge:

```md
![[attachments/diagram.png]]
```

This should still create a contextual note edge:

```md
[[related-note]]
```

### Graph Behavior

The graph should remain note-only.

Image files should not:

- Appear as nodes.
- Appear in graph search as separate records.
- Create hierarchy edges.
- Create dotted contextual edges.
- Affect graph layout.
- Affect `layout.json`.

The note containing the image remains searchable because the embed text is part of the Markdown body.

### Search Behavior

V1 search can remain text-based.

Expected behavior:

- Searching `diagram.png` can find notes containing that embed text.
- Searching `attachments/` can find notes with local image embeds.
- The image file itself does not become a separate search result.
- No OCR or image metadata indexing.

### Attachment Cache

Cache rendered attachment data in the frontend by:

```text
notesPath + attachmentPath + signature
```

Cache invalidation:

- If `read_attachment` returns a new signature, refresh the image.
- If the note body changes but the same attachment signature is used, reuse the cached data.
- If the workspace changes, clear the cache.

### Error Handling

Use compact editor placeholders and status messages.

Common cases:

- No writable workspace: show `Open a folder to add images`.
- No active note: show `Select a note to add images`.
- Unsupported type: show `Only PNG, JPG, GIF, WebP, and AVIF images are supported`.
- File too large: show `Image is too large`.
- Missing file: render a placeholder in the editor.
- Invalid path: render a placeholder and do not attempt a native read.

Errors should not corrupt Markdown content.

### Security And Privacy

V1 must stay local-first.

Do not:

- Fetch remote image URLs.
- Upload attachments.
- Render arbitrary HTML.
- Add broad local file read commands.
- Allow absolute file references.
- Follow symlinks outside the notes folder.
- Allow attachment writes outside `attachments/`.

Image rendering should use browser-safe image elements created from validated local attachment bytes.

### Documentation Updates For V1

When image support is implemented, update user-facing docs with:

- Supported formats.
- Paste/drop behavior.
- Attachment folder behavior.
- Embed syntax examples.
- Missing image behavior.
- Statement that images do not become graph nodes.

The bundled writing skill should mention that images can be embedded in bodies, but hierarchy still belongs only in frontmatter.

### Test Plan For V1

Automated tests:

- Image embed parser recognizes wiki image embeds.
- Image embed parser recognizes Markdown image syntax.
- Size parser handles width-only and width-height syntax.
- Invalid sizes fall back safely.
- Image embeds do not enter note reference edges.
- Markdown note refs still enter note reference edges.
- Attachment path validation rejects absolute paths.
- Attachment path validation rejects traversal.
- Attachment path validation rejects unsupported extensions.
- Attachment path validation rejects symlink escape attempts.
- `manifest.json` still rejects non-Markdown paths.
- `layout.json` remains keyed by note path only.

Manual tests:

- Paste a PNG into a note and confirm it renders.
- Paste multiple images and confirm each gets a separate embed.
- Drop a JPG into the editor and confirm it renders.
- Reopen the workspace and confirm images still render.
- Delete an image from `attachments/` and confirm the note shows a missing placeholder.
- Try to embed `../outside.png` and confirm it is rejected.
- Try to embed an SVG and confirm it is unsupported in v1.
- Confirm graph layout does not change because of image embeds.
- Confirm Markdown file drop on the graph still imports notes.

Acceptance criteria:

- Images can be pasted into notes.
- Images can be dropped into the editor.
- Images are stored under `attachments/`.
- Image embeds render inline.
- Reopening a workspace preserves image rendering.
- Missing images fail gracefully.
- Unsupported images fail gracefully.
- Image embeds do not affect graph edges.
- No frontmatter schema changes.
- No manifest schema changes.

## Future Media Support Outline

Image v1 should create the attachment foundation. Further media support can extend it once image handling is stable.

### V2: Audio

Support local audio attachments.

Possible syntax:

```md
![[attachments/interview.mp3]]
![[attachments/voice-note.wav]]
```

Possible supported formats:

- `.mp3`
- `.wav`
- `.m4a`
- `.ogg`
- `.webm`
- `.flac`

Rendering:

- Use a compact native audio player.
- Show filename and duration when available.
- Keep controls inside the editor width.
- Do not autoplay.

Additional needs:

- Larger file size rules.
- Efficient local file serving instead of base64 for bigger files.
- Clear unsupported codec messaging.

### V3: Video

Support local video attachments.

Possible syntax:

```md
![[attachments/demo.mp4]]
![[attachments/clip.webm]]
```

Possible supported formats:

- `.mp4`
- `.webm`
- `.mov`

Rendering:

- Use a constrained native video player.
- Do not autoplay.
- Use controls by default.
- Respect editor width.
- Avoid loading large video bytes into memory unnecessarily.

Before video support, replace base64 attachment reads with local asset URLs or streaming.

### V4: PDF

Support local PDF attachments.

Possible syntax:

```md
![[attachments/document.pdf]]
![[attachments/document.pdf#page=3]]
```

Initial rendering can be simple:

- Show filename.
- Show file size.
- Provide an open button.
- Optionally show a first-page preview later.

Full inline PDF viewing can come later. It should not make editor rendering slow or fragile.

### Attachment Browser

A future attachment browser can show:

- All attachments in the workspace.
- Attachments used by the active note.
- Missing attachments.
- Unused attachments.
- File sizes.
- File types.
- Last modified dates.

Useful actions:

- Insert embed.
- Copy embed syntax.
- Open in system viewer.
- Rename attachment and update note links.
- Delete unused attachment.

This should come after basic embeds are reliable.

### Rename And Cleanup

Future rename support should:

- Rename the file safely inside the notes folder.
- Update every Markdown reference to the old path.
- Preserve note content outside those references.
- Ask for confirmation before broad edits.

Future cleanup support should:

- Identify attachments with no references.
- Show a review list before deletion.
- Move files to Trash instead of permanent delete when possible.

### Remote Media

Remote media should be a separate product decision.

If added, it should be explicit and privacy-aware:

- Do not fetch remote media silently.
- Show remote URLs as remote content.
- Consider a setting before loading remote images.
- Never copy remote media into the workspace unless the user asks.

### Search And Indexing

Future search can become media-aware without turning media into graph nodes.

Possible search improvements:

- Find notes by attachment filename.
- Find notes by attachment path.
- Filter notes with images.
- Filter notes with missing attachments.
- Filter notes with unsupported media.

Defer OCR and media content extraction until there is a clear user need.

### Long-Term Direction

Apex Notes should support media as local Markdown attachments.

The durable model should stay:

- Notes are Markdown files.
- Media files are attachments.
- `parent` frontmatter defines hierarchy.
- Body wiki links between notes define contextual references.
- Media embeds enrich note bodies but do not define graph structure.

