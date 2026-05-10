# Contributing

Thanks for wanting to improve Apex Notes.

## Local Setup

```sh
npm install
npm run dev
```

This starts the Tauri desktop app. Use `Open notes folder` or `Create folder` to test with local Markdown files.

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
