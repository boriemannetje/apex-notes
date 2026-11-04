# Open and sync a workspace from a browser

Requires the packaged Apex Notes 0.1.10 app or newer. Older installations do not register `apex-notes://`. Installing the update registers the scheme on macOS; a web page cannot register it for the user. Deep links work when the app is already running and on a cold launch. No browser credentials are transferred automatically.

## Open a local workspace

Create an ordinary link from a user click:

```js
const uri = `apex-notes://open?path=${encodeURIComponent(absoluteWorkspacePath)}`;
```

The path must be an existing absolute folder path, not a shell command, `file://` URL, or `~` shortcut. Apex asks before opening an incoming workspace request. It saves pending changes before changing the view. This action reads a workspace; it does not download or overwrite notes.

## Sync a configured private export, then open

```html
<a href="apex-notes://sync?connection=my-diary">Open in Apex Notes</a>
```

The connection ID is only a local routing identifier. Do not put credentials, export contents, export URLs, or a destination path in the URI. Each accepted click requests a fresh export. The app serializes handoffs and temporarily blocks editing during the sync. If a pending local save fails, syncing does not start.

Browser connection IDs start with an ASCII letter or digit and contain only letters, digits, hyphens, or underscores, up to 64 characters. Requests with duplicate or unsupported parameters are rejected.

Before using the link, provision an existing workspace and a trusted local connection. On macOS the configuration file is:

```text
~/Library/Application Support/app.apex.notes/sync-connections.json
```

It must be a regular, current-user-owned file with owner-only permissions (`0600`), not a symlink. Its parent directory should also be private. Use a local editor or credential provisioner, not a secret embedded in a shell command, web page, repository, URL, or log.

```json
{
  "version": 1,
  "connections": [
    {
      "id": "my-diary",
      "rootPath": "/Users/you/Documents/My Diary",
      "exportUrl": "https://your-private-host.example/api/apex-export",
      "authorization": "Bearer YOUR_PRIVATE_EXPORT_TOKEN"
    }
  ]
}
```

`authorization` is sent as the `Authorization` header. For an owner-private ChatGPT Site, optional `sitesAuthorization` supplies the `OAI-Sites-Authorization` header; provide the headers your host requires. A Sites service token is a broader credential, **not** an export-scoped token. Keep it private, restrict its use to the configured export endpoint, and revoke it if exposed. Apex does not issue credentials or bypass a site's authentication. Provisioning a connection is a local trust decision; a browser link cannot create or change it.

Only HTTPS endpoints without URL credentials, query strings, or fragments are accepted. Redirects are rejected so credentials are not forwarded to another endpoint. Connection files and responses are size-limited. HTTP/authentication errors are reported without revealing headers or response contents. Private sync currently requires Unix owner/permission checks; unsupported platforms fail closed rather than ignore those protections.

## Export v1 format

The configured endpoint must return a bounded UTF-8 JSON object. `files` maps paths relative to the workspace's note root to file **content strings**, not download URLs:

```json
{
  "version": 1,
  "files": {
    "day.md": "---\ntitle: \"A day\"\nparent: null\n---\n\nA short story.\n",
    "manifest.json": "[\"day.md\"]",
    "layout.json": "{\"day.md\":{\"x\":0,\"y\":0}}",
    "annotations.json": "{\"version\":1,\"items\":[]}"
  }
}
```

Limits: 16 MiB response, 5,000 files. The destination must already exist; if it has a `notes/` directory, that is the note root. Only Markdown files and root `manifest.json`, `layout.json`, and `annotations.json` are accepted. Import paths use conservative ASCII components; absolute paths, hidden paths, traversal, backslashes, symlinks, case-insensitive aliases, and file/directory collisions are rejected. Use stable filenames and deterministic content. `dates.json`, authentication files, and sync state must not be exported. Annotation sidecars must follow the app's existing v1 shape schema and limits.

## Local edits and failure handling

- Sync never deletes a local Markdown note merely because the remote export omitted it.
- A changed remote file replaces a local file only if it still matches the last successfully imported version. Identical content is accepted without rewriting it.
- Locally edited or deleted files, and first-import name collisions, are preserved. Incoming alternatives are saved under `.apex-sync-conflicts/`; the app reports conflicts instead of silently choosing the remote version. Dot-directories are not loaded as notes.
- Local layout/annotation edits receive the same conflict protection. `dates.json` remains local and unchanged by the importer.
- The manifest is rebuilt from actual Markdown files rather than blindly adopting the supplied list.
- Inputs are validated before mutation. Writes are atomic per file, with a rollback journal and provenance state written last. If concurrent external changes prevent complete rollback, they are preserved and the app reloads the fresh disk state with a warning. Do not edit the same workspace concurrently in another program during sync.
- This is an incoming snapshot sync, not two-way editing or an unattended background service. Resolve reported conflicts explicitly before treating local and remote content as identical.

Preflight scans are bounded to 20,000 existing notes / 64 MiB and 32 levels of nesting. The importer retains original versions under `.apex-sync-backups/` and provenance in `.apex-sync-state-<connection>.json`; do not edit that provenance to force overwrites. A process crash may leave `.apex-sync.lock`; remove it only after confirming no sync process is running and inspecting recovery copies. Retrying remains conservative if an interrupted import left a file without committed provenance.

For browser UI, provide an install/help fallback. Launching a custom URI is not a reliable success receipt: report “Opening Apex Notes,” not “Synced,” until the native app confirms completion. Browser permission prompts and missing handlers vary by browser.
