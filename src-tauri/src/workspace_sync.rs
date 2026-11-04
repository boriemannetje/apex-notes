//! Private, locally provisioned export connections. No URI-provided URLs or credentials.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 5_000;
const MAX_LOCAL_BYTES: usize = 64 * 1024 * 1024;
static SYNC_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connections {
    version: u32,
    connections: Vec<Connection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    id: String,
    root_path: String,
    export_url: String,
    #[serde(default)]
    authorization: Option<String>,
    #[serde(default)]
    sites_authorization: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    version: u32,
    #[serde(deserialize_with = "unique_files")]
    files: BTreeMap<String, String>,
}

fn unique_files<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Files;
    impl<'de> serde::de::Visitor<'de> for Files {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a unique file/content map")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut files = BTreeMap::new();
            while let Some((path, content)) = map.next_entry::<String, String>()? {
                if files.insert(path, content).is_some() {
                    return Err(serde::de::Error::custom("duplicate export path"));
                }
                if files.len() > MAX_FILES {
                    return Err(serde::de::Error::custom("too many export files"));
                }
            }
            Ok(files)
        }
    }
    deserializer.deserialize_map(Files)
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportState {
    version: u32,
    hashes: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncResult {
    workspace: Option<super::Workspace>,
    root_path: String,
    notes_path: String,
    reload_required: bool,
    conflicts: Vec<String>,
    updated: usize,
    unchanged: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
pub(super) async fn sync_workspace(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<SyncResult, String> {
    let config_path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Could not resolve private connection configuration")?
        .join("sync-connections.json");
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SYNC_LOCK
            .try_lock()
            .map_err(|_| "Another workspace sync is already running")?;
        let connection = read_connection(&config_path, &connection_id)?;
        let (root, notes_root) = resolve_root(&connection.root_path)?;
        let export = fetch_export(&connection)?;
        let outcome = import_export(&notes_root, &connection.id, export);
        let (conflicts, updated, unchanged, warning) = match outcome {
            Ok((conflicts, updated, unchanged)) => (conflicts, updated, unchanged, None),
            Err(error) if error.partial => (Vec::new(), 0, 0, Some(error.message)),
            Err(error) => return Err(error.message),
        };
        let root_path = root.to_string_lossy().into_owned();
        let notes_path = notes_root.to_string_lossy().into_owned();
        // A late external filesystem change must not leave the renderer editing
        // its pre-import snapshot. A null workspace requires the UI to invalidate
        // every tab addressing this root before it unlocks editing.
        let (workspace, reload_required, warning) = match super::workspace_from_paths(root, notes_root) {
            Ok(workspace) => (Some(workspace), false, warning),
            Err(_) => (None, true, Some("Sync could not reload the workspace after writing. Close affected tabs and reopen the folder before editing; local files and recovery copies are preserved.".into())),
        };
        Ok(SyncResult {
            workspace,
            root_path,
            notes_path,
            reload_required,
            conflicts,
            updated,
            unchanged,
            warning,
        })
    })
    .await
    .map_err(|_| "Workspace sync worker failed".to_string())?
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn read_connection(path: &Path, id: &str) -> Result<Connection, String> {
    #[cfg(not(unix))]
    return Err("Private sync is currently supported only on systems with verified owner-only file permissions".into());
    if !valid_id(id) {
        return Err("Invalid sync connection ID".into());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Configure sync-connections.json in Apex Notes application support first")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Sync configuration must be a regular file, not a symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(
                "Sync configuration must be owned by this user with permissions 0600".into(),
            );
        }
    }
    let raw = read_regular_with_privacy(path, MAX_CONFIG_BYTES, true)?
        .ok_or("Sync configuration disappeared")?;
    let config: Connections =
        serde_json::from_slice(&raw).map_err(|_| "Invalid sync connection configuration")?;
    if config.version != 1 || config.connections.len() > 32 {
        return Err("Unsupported or oversized sync connection configuration".into());
    }
    let mut ids = BTreeSet::new();
    for connection in &config.connections {
        if !valid_id(&connection.id) || !ids.insert(&connection.id) {
            return Err("Sync connections need unique valid IDs".into());
        }
    }
    let connection = config
        .connections
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or("Unknown local sync connection; provision it in sync-connections.json first")?;
    validate_connection(&connection)?;
    Ok(connection)
}

fn validate_connection(connection: &Connection) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(&connection.export_url).map_err(|_| "Invalid configured export URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Export URL must be HTTPS without credentials, query, or fragment".into());
    }
    let headers = [&connection.authorization, &connection.sites_authorization];
    if headers
        .iter()
        .all(|value| value.as_deref().unwrap_or("").is_empty())
    {
        return Err("Private sync requires a locally provisioned authorization header".into());
    }
    for value in headers.into_iter().flatten() {
        if value.is_empty()
            || value.len() > 8192
            || value.chars().any(char::is_control)
            || reqwest::header::HeaderValue::from_str(value).is_err()
        {
            return Err("Invalid private authorization header".into());
        }
    }
    Ok(url)
}

fn fetch_export(connection: &Connection) -> Result<Export, String> {
    let url = validate_connection(connection)?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "Could not initialize private export client")?;
    let mut request = client
        .get(url)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache");
    if let Some(value) = &connection.authorization {
        request = request.header("Authorization", value);
    }
    if let Some(value) = &connection.sites_authorization {
        request = request.header("OAI-Sites-Authorization", value);
    }
    let response = request
        .send()
        .map_err(|_| "Private export request failed; check connection and authorization")?;
    if !response.status().is_success() {
        return Err(format!(
            "Private export returned HTTP {}; no files imported",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_EXPORT_BYTES as u64)
    {
        return Err("Private export exceeds 16 MiB".into());
    }
    let mut raw = Vec::new();
    response
        .take(MAX_EXPORT_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "Could not read private export")?;
    parse_export(&raw)
}

fn resolve_root(value: &str) -> Result<(PathBuf, PathBuf), String> {
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Configured workspace must be an absolute existing folder".into());
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        cursor.push(component.as_os_str());
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|_| "Configured workspace is unavailable")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Configured workspace cannot contain symlink or non-directory components".into(),
            );
        }
    }
    let root = path
        .canonicalize()
        .map_err(|_| "Could not resolve workspace folder")?;
    let candidate = root.join("notes");
    let notes_root = match fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Notes folder cannot be a symlink".into())
        }
        Ok(metadata) if metadata.is_dir() => candidate,
        Ok(_) => return Err("Existing notes entry is not a folder".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => root.clone(),
        Err(_) => return Err("Could not inspect note root".into()),
    };
    Ok((root, notes_root))
}

fn validate_path(value: &str, markdown_only: bool) -> Result<(), String> {
    if value.is_empty()
        || !value.is_ascii()
        || value.len() > 1024
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
        || value.split('/').count() > 32
        || value
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.len() > 255)
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Export contains an unsafe relative path".into());
    }
    let markdown = value.to_ascii_lowercase().ends_with(".md");
    if !markdown
        && (markdown_only || !matches!(value, "manifest.json" | "layout.json" | "annotations.json"))
    {
        return Err("Export may contain only Markdown and supported root sidecars".into());
    }
    Ok(())
}

fn parse_export(raw: &[u8]) -> Result<Export, String> {
    if raw.len() > MAX_EXPORT_BYTES {
        return Err("Private export exceeds 16 MiB".into());
    }
    let export: Export = serde_json::from_slice(raw).map_err(|_| "Invalid private export JSON")?;
    validate_export(&export)?;
    Ok(export)
}

fn validate_export(export: &Export) -> Result<(), String> {
    if export.version != 1 || export.files.len() > MAX_FILES {
        return Err("Unsupported export version or more than 5,000 files".into());
    }
    let mut bytes = 0usize;
    // Case-insensitive macOS filesystems must not alias two incoming destinations.
    let mut names = BTreeSet::new();
    let all_paths: BTreeSet<_> = export
        .files
        .keys()
        .map(|path| path.to_ascii_lowercase())
        .collect();
    for (path, content) in &export.files {
        validate_path(path, false)?;
        if !names.insert(path.to_lowercase()) {
            return Err("Export contains case-colliding paths".into());
        }
        let mut prefix = String::new();
        for part in path
            .split('/')
            .take(path.split('/').count().saturating_sub(1))
        {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if all_paths.contains(&prefix.to_ascii_lowercase()) {
                return Err("Export contains a file/directory path collision".into());
            }
        }
        bytes = bytes
            .checked_add(content.len() + path.len())
            .ok_or("Export byte count overflow")?;
        if bytes > MAX_EXPORT_BYTES {
            return Err("Private export exceeds 16 MiB".into());
        }
        match path.as_str() {
            "annotations.json" => {
                let annotations: super::AnnotationDocument = serde_json::from_str(content)
                    .map_err(|_| "Export annotations.json is invalid")?;
                super::validate_annotations(&annotations)?;
                if content.len() > super::MAX_ANNOTATION_DOCUMENT_BYTES as usize {
                    return Err("Export annotations.json exceeds 4 MiB".into());
                }
            }
            "layout.json" => {
                let layout: BTreeMap<String, BTreeMap<String, f64>> =
                    serde_json::from_str(content).map_err(|_| "Export layout.json is invalid")?;
                if layout.len() > MAX_FILES {
                    return Err("Export layout has too many entries".into());
                }
                for (note, position) in layout {
                    validate_path(&note, true)?;
                    if position
                        .keys()
                        .any(|key| !matches!(key.as_str(), "x" | "y" | "dx" | "dy"))
                        || position.values().any(|value| !value.is_finite())
                    {
                        return Err("Export layout contains unsupported geometry".into());
                    }
                }
            }
            "manifest.json" => {
                let manifest: Vec<String> =
                    serde_json::from_str(content).map_err(|_| "Export manifest.json is invalid")?;
                if manifest.len() > MAX_FILES {
                    return Err("Export manifest has too many entries".into());
                }
                let mut paths = BTreeSet::new();
                for note in manifest {
                    validate_path(&note, true)?;
                    if !paths.insert(note) {
                        return Err("Export manifest repeats paths".into());
                    }
                }
            }
            _ => {
                if content.contains('\0') {
                    return Err("Markdown export contains NUL bytes".into());
                }
            }
        }
    }
    Ok(())
}

fn read_regular(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    read_regular_with_privacy(path, limit, false)
}

fn read_regular_with_privacy(
    path: &Path,
    limit: usize,
    private: bool,
) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("Sync path must be a regular file, not a symlink".into())
        }
        Ok(metadata) if metadata.len() > limit as u64 => {
            return Err("Local sync file exceeds its size limit".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect local sync file".into()),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not safely open local sync file")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Could not inspect open sync file")?;
    if !metadata.is_file() {
        return Err("Sync path is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if private && (metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() })
        {
            return Err(
                "Opened sync configuration must be owned by this user with permissions 0600".into(),
            );
        }
    }
    #[cfg(not(unix))]
    if private {
        return Err("Private sync permissions are not supported on this platform".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read local sync file")?;
    if bytes.len() > limit {
        return Err("Local sync file exceeds its size limit".into());
    }
    Ok(Some(bytes))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct FolderLock(PathBuf);
impl Drop for FolderLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn acquire_folder_lock(root: &Path) -> Result<FolderLock, String> {
    let path = root.join(".apex-sync.lock");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| "Workspace sync lock exists; another sync may be running. After confirming no sync is running, remove .apex-sync.lock to recover from an interrupted process")?;
    write!(file, "{}", std::process::id()).map_err(|_| "Could not write sync lock")?;
    Ok(FolderLock(path))
}

fn private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => return Ok(()),
        Ok(_) => return Err("Sync directory cannot be a symlink or file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not inspect sync directory".into()),
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "Could not create private sync directory".to_string())
}

fn ensure_parents(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = super::safe_child_path(root, relative)?;
    let mut parent = root.to_path_buf();
    let parts: Vec<_> = Path::new(relative).components().collect();
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        parent.push(part.as_os_str());
        private_directory(&parent)?;
    }
    super::safe_child_path(root, relative)?;
    Ok(path)
}

fn keep_copy(root: &Path, category: &str, relative: &str, bytes: &[u8]) -> Result<String, String> {
    let directory = root.join(category);
    private_directory(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| "Could not inspect recovery directory")?;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Recovery directories must be private to the current user (0700)".into());
        }
    }
    let generation = hash(bytes);
    let generation_root = directory.join(&generation);
    private_directory(&generation_root)?;
    let path = ensure_parents(&generation_root, relative)?;
    if let Some(existing) = read_regular(&path, MAX_EXPORT_BYTES)? {
        if existing != bytes {
            return Err(
                "An existing recovery copy does not match; refusing to overwrite it".into(),
            );
        }
    } else {
        super::atomic_write_file(&path, bytes, None, MAX_EXPORT_BYTES as u64)
            .map_err(|_| "Could not safely save recovery copy")?;
    }
    Ok(format!("{category}/{generation}/{relative}"))
}

fn scan_markdown(root: &Path) -> Result<Vec<String>, String> {
    fn walk(
        root: &Path,
        dir: &Path,
        depth: usize,
        count: &mut usize,
        bytes: &mut u64,
        paths: &mut Vec<String>,
    ) -> Result<(), String> {
        if depth > 32 {
            return Err("Workspace nesting exceeds sync limit".into());
        }
        for entry in fs::read_dir(dir).map_err(|_| "Could not inspect workspace files")? {
            let entry = entry.map_err(|_| "Could not inspect workspace entry")?;
            *count += 1;
            if *count > 100_000 {
                return Err("Workspace has too many entries to sync safely".into());
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| "Could not inspect workspace entry")?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                walk(root, &entry.path(), depth + 1, count, bytes, paths)?;
            } else if metadata.is_file() && super::is_markdown_path(&entry.path()) {
                *bytes = bytes.saturating_add(metadata.len());
                if *bytes > MAX_LOCAL_BYTES as u64 || paths.len() >= 20_000 {
                    return Err(
                        "Workspace exceeds safe sync scan limits (20,000 notes / 64 MiB)".into(),
                    );
                }
                paths.push(super::path_to_frontend(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|_| "Workspace path escaped root")?,
                ));
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    walk(root, root, 0, &mut 0, &mut 0, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn preflight_readability(root: &Path) -> Result<(), String> {
    let paths = scan_markdown(root)?;
    let mut total = 0usize;
    for relative in paths {
        let path = super::safe_child_path(root, &relative)?;
        let raw =
            read_regular(&path, MAX_EXPORT_BYTES)?.ok_or("Local note changed during preflight")?;
        total += raw.len();
        if total > MAX_LOCAL_BYTES {
            return Err("Workspace exceeds safe sync read limit of 64 MiB".into());
        }
        std::str::from_utf8(&raw)
            .map_err(|_| "Existing local Markdown is not valid UTF-8; no import performed")?;
    }
    if let Some(raw) = read_regular(&root.join("layout.json"), MAX_EXPORT_BYTES)? {
        std::str::from_utf8(&raw)
            .map_err(|_| "Existing local layout is not valid UTF-8; no import performed")?;
    }
    Ok(())
}

#[derive(Debug)]
struct ImportFailure {
    message: String,
    partial: bool,
}
impl From<String> for ImportFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            partial: false,
        }
    }
}
impl From<&str> for ImportFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

struct JournalEntry {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

fn write_journaled(
    journal: &mut Vec<JournalEntry>,
    path: PathBuf,
    after: Vec<u8>,
    before: Option<Vec<u8>>,
) -> Result<(), String> {
    // Register before rename: directory fsync can fail after the rename succeeded.
    journal.push(JournalEntry {
        path,
        before,
        after,
    });
    let entry = journal.last().unwrap();
    super::atomic_write_file(
        &entry.path,
        &entry.after,
        entry.before.as_deref(),
        MAX_EXPORT_BYTES as u64,
    )
    .map_err(|_| "Workspace changed or an import write failed".into())
}

fn rollback(journal: &[JournalEntry]) -> bool {
    let mut complete = true;
    for entry in journal.iter().rev() {
        let current = match read_regular(&entry.path, MAX_EXPORT_BYTES) {
            Ok(value) => value,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if current == entry.before {
            continue;
        }
        if current.as_deref() != Some(entry.after.as_slice()) {
            complete = false;
            continue;
        }
        let result = if let Some(before) = &entry.before {
            super::atomic_write_file(
                &entry.path,
                before,
                Some(&entry.after),
                MAX_EXPORT_BYTES as u64,
            )
        } else {
            fs::remove_file(&entry.path)
        };
        if result.is_err() {
            complete = false;
        }
    }
    complete
}

fn reject_existing_aliases(root: &Path, relative: &str) -> Result<(), String> {
    let mut cursor = root.to_path_buf();
    for requested in relative.split('/') {
        if !cursor.exists() {
            break;
        }
        for entry in
            fs::read_dir(&cursor).map_err(|_| "A destination parent is not an accessible folder")?
        {
            let entry = entry.map_err(|_| "Could not inspect destination aliases")?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.to_lowercase() == requested.to_ascii_lowercase() && name != requested {
                return Err("Import path aliases an existing differently-cased local path".into());
            }
        }
        cursor.push(requested);
    }
    Ok(())
}

fn import_export(
    root: &Path,
    connection_id: &str,
    export: Export,
) -> Result<(Vec<String>, usize, usize), ImportFailure> {
    validate_export(&export)?;
    if !valid_id(connection_id) {
        return Err("Invalid sync connection ID".into());
    }
    let _lock = acquire_folder_lock(root)?;
    preflight_readability(root)?;
    let state_path = root.join(format!(".apex-sync-state-{connection_id}.json"));
    reject_existing_aliases(root, &format!(".apex-sync-state-{connection_id}.json"))?;
    let old_state_raw = read_regular(&state_path, MAX_STATE_BYTES)?;
    let mut state: ImportState = match &old_state_raw {
        Some(raw) => serde_json::from_slice(raw)
            .map_err(|_| "Invalid local sync provenance; leaving it untouched")?,
        None => ImportState {
            version: 1,
            hashes: BTreeMap::new(),
        },
    };
    if state.version != 1 || state.hashes.len() > MAX_FILES {
        return Err("Unsupported or oversized local sync provenance".into());
    }
    for (path, digest) in &state.hashes {
        validate_path(path, false)?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Invalid local sync provenance digest".into());
        }
    }
    let mut projected = state.hashes.clone();
    for path in export
        .files
        .keys()
        .filter(|path| path.as_str() != "manifest.json")
    {
        projected
            .entry(path.clone())
            .or_insert_with(|| "0".repeat(64));
    }
    if projected.len() > MAX_FILES
        || serde_json::to_vec(&ImportState {
            version: 1,
            hashes: projected,
        })
        .map_err(|_| "Could not measure sync provenance")?
        .len()
            > MAX_STATE_BYTES
    {
        return Err("Sync provenance would exceed its limit; no files imported".into());
    }
    let manifest_path = root.join("manifest.json");
    reject_existing_aliases(root, "manifest.json")?;
    let old_manifest = read_regular(&manifest_path, MAX_EXPORT_BYTES)?;
    let mut plans = Vec::new();
    let mut local_bytes = 0usize;
    for (relative, incoming) in export.files {
        if relative == "manifest.json" {
            continue;
        }
        reject_existing_aliases(root, &relative)?;
        let path = super::safe_child_path(root, &relative)?;
        let current = read_regular(&path, MAX_EXPORT_BYTES)?;
        local_bytes += current.as_ref().map_or(0, Vec::len);
        if local_bytes > MAX_LOCAL_BYTES {
            return Err("Local import preflight exceeds 64 MiB".into());
        }
        let incoming_hash = hash(incoming.as_bytes());
        let identical = current.as_deref() == Some(incoming.as_bytes());
        let replace = match (&current, state.hashes.get(&relative)) {
            (Some(raw), Some(previous)) => hash(raw) == *previous,
            (None, None) => true,
            _ => false,
        };
        plans.push((
            relative,
            incoming,
            incoming_hash,
            current,
            identical,
            replace,
        ));
    }
    let mut journal = Vec::new();
    let outcome = (|| -> Result<(Vec<String>, usize, usize), String> {
        let mut conflicts = Vec::new();
        let mut updated = 0;
        let mut unchanged = 0;
        for (relative, incoming, incoming_hash, current, identical, replace) in plans {
            if identical {
                state.hashes.insert(relative, incoming_hash);
                unchanged += 1;
            } else if replace {
                if let Some(previous) = &current {
                    keep_copy(root, ".apex-sync-backups", &relative, previous)?;
                }
                let path = ensure_parents(root, &relative)?;
                write_journaled(&mut journal, path, incoming.into_bytes(), current)?;
                state.hashes.insert(relative, incoming_hash);
                updated += 1;
            } else {
                conflicts.push(keep_copy(
                    root,
                    ".apex-sync-conflicts",
                    &relative,
                    incoming.as_bytes(),
                )?);
            }
        }
        // Never trust an exported manifest to delete or hide local notes.
        let paths = scan_markdown(root)?;
        let manifest = serde_json::to_vec_pretty(&paths)
            .map_err(|_| "Could not serialize workspace manifest")?;
        if old_manifest.as_deref() != Some(manifest.as_slice()) {
            if let Some(old) = &old_manifest {
                keep_copy(root, ".apex-sync-backups", "manifest.json", old)?;
            }
            write_journaled(&mut journal, manifest_path, manifest, old_manifest)?;
        }
        let next_state =
            serde_json::to_vec(&state).map_err(|_| "Could not serialize sync provenance")?;
        if next_state.len() > MAX_STATE_BYTES {
            return Err("Sync provenance exceeds size limit".into());
        }
        if old_state_raw.as_deref() != Some(next_state.as_slice()) {
            write_journaled(&mut journal, state_path, next_state, old_state_raw)?;
        }
        Ok((conflicts, updated, unchanged))
    })();
    match outcome {
        Ok(value) => Ok(value),
        Err(message) => {
            let complete = rollback(&journal);
            Err(ImportFailure {
                message: if complete {
                    format!("{message}; imported changes were rolled back. Recovery copies are retained.")
                } else {
                    format!("{message}; rollback preserved intervening local edits and could not restore every path. Workspace reloaded; inspect .apex-sync-backups and .apex-sync-conflicts before retrying.")
                },
                partial: !complete,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "apex-sync-test-{}-{}-{}",
                std::process::id(),
                super::super::now_ms(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn export(items: &[(&str, &str)]) -> Export {
        Export {
            version: 1,
            files: items
                .iter()
                .map(|(path, raw)| (path.to_string(), raw.to_string()))
                .collect(),
        }
    }
    fn connection() -> Connection {
        Connection {
            id: "diary".into(),
            root_path: "/tmp/workspace".into(),
            export_url: "https://example.com/api/apex-export".into(),
            authorization: Some("Bearer private-test-token".into()),
            sites_authorization: None,
        }
    }

    #[test]
    fn repeated_sync_updates_only_unchanged_imports_and_preserves_missing_remote_notes() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let first = import_export(
            root,
            "diary",
            export(&[("a.md", "first"), ("nested/b.md", "keep")]),
        )
        .unwrap();
        assert_eq!((first.0.len(), first.1, first.2), (0, 2, 0));
        let modified = fs::metadata(root.join("a.md")).unwrap().modified().unwrap();
        let repeat = import_export(
            root,
            "diary",
            export(&[("a.md", "first"), ("nested/b.md", "keep")]),
        )
        .unwrap();
        assert_eq!((repeat.1, repeat.2), (0, 2));
        assert_eq!(
            fs::metadata(root.join("a.md")).unwrap().modified().unwrap(),
            modified
        );
        import_export(root, "diary", export(&[("a.md", "second")])).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "second");
        assert_eq!(
            fs::read_to_string(root.join("nested/b.md")).unwrap(),
            "keep"
        );
        let manifest: Vec<String> =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest, ["a.md", "nested/b.md"]);
        assert_eq!(
            fs::read_to_string(
                root.join(".apex-sync-backups")
                    .join(hash(b"first"))
                    .join("a.md")
            )
            .unwrap(),
            "first"
        );
    }

    #[test]
    fn local_edits_deletions_and_first_import_collisions_keep_incoming_conflict_copies() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        import_export(
            root,
            "diary",
            export(&[("edited.md", "old"), ("deleted.md", "old")]),
        )
        .unwrap();
        fs::write(root.join("edited.md"), "local edit").unwrap();
        fs::remove_file(root.join("deleted.md")).unwrap();
        fs::write(root.join("new.md"), "existing private content").unwrap();
        let incoming = export(&[
            ("edited.md", "remote"),
            ("deleted.md", "remote"),
            ("new.md", "remote"),
        ]);
        let result = import_export(root, "diary", incoming).unwrap();
        assert_eq!(result.0.len(), 3);
        assert_eq!(
            fs::read_to_string(root.join("edited.md")).unwrap(),
            "local edit"
        );
        assert!(!root.join("deleted.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "existing private content"
        );
        for conflict in &result.0 {
            assert_eq!(fs::read_to_string(root.join(conflict)).unwrap(), "remote");
        }
        let again = import_export(
            root,
            "diary",
            export(&[
                ("edited.md", "remote"),
                ("deleted.md", "remote"),
                ("new.md", "remote"),
            ]),
        )
        .unwrap();
        assert_eq!(again.0, result.0);
    }

    #[test]
    fn sidecars_are_validated_and_local_annotation_edits_and_dates_survive() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let empty = "{\"version\":1,\"items\":[]}";
        import_export(
            root,
            "diary",
            export(&[
                ("a.md", "A"),
                ("annotations.json", empty),
                ("layout.json", "{\"a.md\":{\"x\":1,\"y\":2}}"),
            ]),
        )
        .unwrap();
        fs::write(root.join("dates.json"), "private dates").unwrap();
        fs::write(root.join("annotations.json"), "local altered annotations").unwrap();
        let next = "{\"version\":1,\"items\":[{\"id\":\"x\",\"type\":\"circle\",\"cx\":0,\"cy\":0,\"radius\":1}]}";
        let result = import_export(root, "diary", export(&[("annotations.json", next)])).unwrap();
        assert_eq!(result.0.len(), 1);
        assert_eq!(
            fs::read_to_string(root.join("annotations.json")).unwrap(),
            "local altered annotations"
        );
        assert_eq!(
            fs::read_to_string(root.join("dates.json")).unwrap(),
            "private dates"
        );
    }

    #[test]
    fn invalid_export_is_rejected_before_any_note_write() {
        let fixture = Fixture::new();
        for invalid in [
            "../escape.md",
            "/absolute.md",
            "a\\b.md",
            "a//b.md",
            ".hidden/a.md",
            "dates.json",
            "run.sh",
        ] {
            assert!(import_export(
                &fixture.0,
                "diary",
                export(&[("a.md", "must not write"), (invalid, "bad")])
            )
            .is_err());
            assert!(!fixture.0.join("a.md").exists());
        }
        assert!(import_export(
            &fixture.0,
            "diary",
            export(&[
                ("a.md", "safe"),
                ("annotations.json", "{\"version\":2,\"items\":[]}")
            ])
        )
        .is_err());
        assert!(!fixture.0.join("a.md").exists());
        assert!(validate_export(&export(&[("A.md", "A"), ("a.md", "a")])).is_err());
    }

    #[test]
    fn malformed_provenance_and_recovery_paths_are_not_overwritten() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let state = root.join(".apex-sync-state-diary.json");
        fs::write(&state, "bad state").unwrap();
        assert!(import_export(root, "diary", export(&[("a.md", "A")])).is_err());
        assert_eq!(fs::read_to_string(state).unwrap(), "bad state");
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn export_and_connection_limits_do_not_leak_credentials() {
        assert!(parse_export(br#"{"version":1,"files":{"a.md":"one","a.md":"two"}}"#).is_err());
        assert!(parse_export(&vec![b' '; MAX_EXPORT_BYTES + 1]).is_err());
        let mut huge = export(&[]);
        for index in 0..=MAX_FILES {
            huge.files.insert(format!("{index}.md"), String::new());
        }
        assert!(validate_export(&huge).is_err());
        for url in [
            "http://example.com/export",
            "https://user:secret@example.com/export",
            "https://example.com/export?token=secret",
            "https://example.com/export#secret",
        ] {
            let mut c = connection();
            c.export_url = url.into();
            let error = validate_connection(&c).unwrap_err();
            assert!(!error.contains("secret"));
            assert!(!error.contains("private-test-token"));
        }
        let mut c = connection();
        c.authorization = None;
        c.sites_authorization = Some("Bearer site-token".into());
        assert!(validate_connection(&c).is_ok());
        c.sites_authorization = None;
        assert!(validate_connection(&c).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn config_permissions_and_symlink_destinations_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let config = fixture.0.join("connections.json");
        fs::write(&config, r#"{"version":1,"connections":[{"id":"diary","rootPath":"/tmp/workspace","exportUrl":"https://example.com/export","authorization":"Bearer test"}]}"#).unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_connection(&config, "diary").is_ok());
        fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_connection(&config, "diary").is_err());
        symlink(&outside.0, fixture.0.join("linked")).unwrap();
        assert!(import_export(&fixture.0, "diary", export(&[("linked/a.md", "bad")])).is_err());
        assert!(!outside.0.join("a.md").exists());
        symlink(outside.0.join("missing.md"), fixture.0.join("a.md")).unwrap();
        assert!(import_export(&fixture.0, "diary", export(&[("a.md", "bad")])).is_err());
        assert!(!outside.0.join("missing.md").exists());
    }

    #[test]
    fn workspace_lock_prevents_overlapping_imports() {
        let fixture = Fixture::new();
        let lock = acquire_folder_lock(&fixture.0).unwrap();
        assert!(import_export(&fixture.0, "diary", export(&[("a.md", "A")])).is_err());
        drop(lock);
        assert!(import_export(&fixture.0, "diary", export(&[("a.md", "A")])).is_ok());
    }

    #[test]
    fn aliases_and_file_ancestors_fail_before_any_import_write() {
        let fixture = Fixture::new();
        for incoming in [
            export(&[("a.md", "A"), ("a.md/b.md", "B")]),
            export(&[("A.md", "A"), ("a.md/b.md", "B")]),
            export(&[("café.md", "A")]),
            export(&[("cafe\u{301}.md", "A")]),
        ] {
            assert!(import_export(&fixture.0, "diary", incoming).is_err());
            assert!(!fixture.0.join("a.md").exists());
        }
        fs::write(fixture.0.join("Day.md"), "private local note").unwrap();
        assert!(import_export(&fixture.0, "diary", export(&[("day.md", "remote")])).is_err());
        assert_eq!(
            fs::read_to_string(fixture.0.join("Day.md")).unwrap(),
            "private local note"
        );
    }

    #[test]
    fn projected_state_limit_fails_before_new_files_are_created() {
        let fixture = Fixture::new();
        let state = ImportState {
            version: 1,
            hashes: (0..MAX_FILES - 1)
                .map(|index| (format!("old-{index}.md"), hash(b"old")))
                .collect(),
        };
        fs::write(
            fixture.0.join(".apex-sync-state-diary.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        let error = import_export(
            &fixture.0,
            "diary",
            export(&[("new-a.md", "A"), ("new-b.md", "B")]),
        )
        .unwrap_err();
        assert!(!error.partial);
        assert!(!fixture.0.join("new-a.md").exists());
        assert!(!fixture.0.join("new-b.md").exists());
    }

    #[test]
    fn io_failure_rolls_back_already_written_notes_and_preserves_original_state() {
        let fixture = Fixture::new();
        import_export(
            &fixture.0,
            "diary",
            export(&[("a.md", "old"), ("z.md", "old")]),
        )
        .unwrap();
        let state = fs::read(fixture.0.join(".apex-sync-state-diary.json")).unwrap();
        // The first write creates its private backup, then the second's recovery
        // parent collides with a real file. This exercises actual mid-apply I/O.
        let backup = fixture.0.join(".apex-sync-backups").join(hash(b"old"));
        fs::create_dir_all(&backup).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                fixture.0.join(".apex-sync-backups"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        fs::write(backup.join("z.md"), "inconsistent recovery copy").unwrap();
        let error = import_export(
            &fixture.0,
            "diary",
            export(&[("a.md", "new-a"), ("z.md", "new-z")]),
        )
        .unwrap_err();
        assert!(!error.partial);
        assert_eq!(fs::read_to_string(fixture.0.join("a.md")).unwrap(), "old");
        assert_eq!(fs::read_to_string(fixture.0.join("z.md")).unwrap(), "old");
        assert_eq!(
            fs::read(fixture.0.join(".apex-sync-state-diary.json")).unwrap(),
            state
        );
    }

    #[test]
    fn rollback_never_overwrites_intervening_local_edits() {
        let fixture = Fixture::new();
        let path = fixture.0.join("a.md");
        fs::write(&path, "old").unwrap();
        let mut journal = Vec::new();
        write_journaled(
            &mut journal,
            path.clone(),
            b"imported".to_vec(),
            Some(b"old".to_vec()),
        )
        .unwrap();
        fs::write(&path, "new local edit").unwrap();
        assert!(!rollback(&journal));
        assert_eq!(fs::read_to_string(path).unwrap(), "new local edit");
    }

    #[test]
    fn unreadable_existing_markdown_fails_before_import() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("local.md"), [0xff, 0xfe]).unwrap();
        let error =
            import_export(&fixture.0, "diary", export(&[("new.md", "remote")])).unwrap_err();
        assert!(!error.partial);
        assert!(!fixture.0.join("new.md").exists());
        assert_eq!(fs::read(fixture.0.join("local.md")).unwrap(), [0xff, 0xfe]);
    }
}
