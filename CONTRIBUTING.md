# Contributing

Thanks for wanting to improve Apex Notes.

This is a small local-first app, so the best contributions are focused, easy to review, and careful with user data.

## Good First Contributions

- Fix a reproducible bug with a small test note set
- Improve Markdown parsing, graph behavior, or workspace reliability
- Clarify docs, release steps, or the writing-agent skill
- Add small UI refinements that preserve the minimal graph/editor workflow

For broad redesigns, new storage formats, or security-sensitive changes, please open an issue before a pull request.

## Local Setup

```sh
npm install
npm run dev
```

This starts the Tauri desktop app. Use `Open notes folder` or `Create folder` to test with local Markdown files.

## Pull Request Flow

1. Fork the repo and create a branch for one focused change.
2. Keep private notes, personal vaults, generated bundles, and separate marketing-site source out of the app repo.
3. Describe the user-visible behavior and the files you changed.
4. Include the commands you ran, or say clearly why a command was not run.
5. Keep PRs small enough that a maintainer can review them in one pass.

## Before A Pull Request

Run:

```sh
npm run build:web
cargo check --manifest-path src-tauri/Cargo.toml
```

For changes that affect release packaging, also run:

```sh
npm run build
```

If you change Rust/Tauri filesystem behavior, include the `cargo check` result. If you change graph or editor behavior, include a short manual smoke test with a local notes folder.

## Notes Schema

Keep the schema intentionally small:

```yaml
---
title: "Human Readable Title"
level: 0
parent: null
---
```

`parent` is the only hierarchy edge. Body `[[wiki links]]` are contextual references and render as dotted graph lines.

When editing existing notes, preserve filenames. When adding or deleting Markdown files under `notes/`, update `notes/manifest.json` in the same PR. Do not add frontmatter fields beyond `title`, `level`, and `parent` unless the schema is intentionally changed.

## Safety Boundaries

- Do not commit private or user-specific notes.
- Do not commit local app bundles, build output, or generated release assets.
- Do not move separate marketing-site source into this repository.
- Treat filesystem, path handling, parser, and Tauri command changes as sensitive.
- Never ask reporters to upload a private notes folder; use a minimal synthetic reproduction instead.
