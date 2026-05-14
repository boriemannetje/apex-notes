# Security Policy

## Supported Versions

Security fixes target the latest released version of Apex Notes. Older builds may be superseded by the next release rather than patched separately.

## Reporting A Vulnerability

Please do not open a public issue for a security vulnerability.

Email `boris@starboat.app` with:

- a short description of the issue
- reproduction steps
- affected platform and version
- whether the issue requires opening a crafted notes folder
- any suggested fix, if you have one

Please do not include private notes or personal vault contents. If a reproduction needs Markdown files, use the smallest synthetic note set that demonstrates the issue.

I will acknowledge serious reports as quickly as I can and coordinate a fix before public disclosure.

## Scope

Especially useful reports include issues involving local file access, unsafe path handling, crafted Markdown/frontmatter, Tauri command behavior, release artifacts, or update/download integrity.
