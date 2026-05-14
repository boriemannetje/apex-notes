use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteFile {
    path: String,
    raw: String,
    signature: String,
    modified_ms: u64,
    byte_len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteFileStatus {
    path: String,
    signature: String,
    modified_ms: u64,
    byte_len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    root_path: String,
    notes_path: String,
    workspace_name: String,
    notes: Vec<NoteFile>,
    positions: HashMap<String, NotePosition>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteWrite {
    path: String,
    raw: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NotePosition {
    x: f64,
    y: f64,
}

#[tauri::command(rename_all = "camelCase")]
async fn read_workspace(root_path: String) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || read_workspace_blocking(root_path))
        .await
        .map_err(to_error)?
}

fn read_workspace_blocking(root_path: String) -> Result<Workspace, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err("Selected path is not a folder".into());
    }

    let notes = root.join("notes");
    let notes_root = if notes.is_dir() { notes } else { root.clone() };
    workspace_from_paths(root, notes_root)
}

#[tauri::command(rename_all = "camelCase")]
async fn list_note_files(notes_path: String) -> Result<Vec<NoteFileStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || list_note_files_blocking(notes_path))
        .await
        .map_err(to_error)?
}

fn list_note_files_blocking(notes_path: String) -> Result<Vec<NoteFileStatus>, String> {
    let notes_root = PathBuf::from(notes_path);
    if !notes_root.is_dir() {
        return Err("Notes path is not a folder".into());
    }

    let mut statuses = Vec::new();
    collect_note_statuses(&notes_root, &notes_root, &mut statuses).map_err(to_error)?;
    statuses.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(statuses)
}

#[tauri::command(rename_all = "camelCase")]
async fn read_notes(notes_path: String, paths: Vec<String>) -> Result<Vec<NoteFile>, String> {
    tauri::async_runtime::spawn_blocking(move || read_notes_blocking(notes_path, paths))
        .await
        .map_err(to_error)?
}

fn read_notes_blocking(notes_path: String, paths: Vec<String>) -> Result<Vec<NoteFile>, String> {
    let notes_root = PathBuf::from(notes_path);
    if !notes_root.is_dir() {
        return Err("Notes path is not a folder".into());
    }

    let mut notes = Vec::with_capacity(paths.len());
    for path in paths {
        if !is_markdown_path(Path::new(&path)) {
            return Err(format!("Only Markdown notes can be read: {}", path));
        }

        let file_path = safe_child_path(&notes_root, &path)?;
        let metadata = fs::metadata(&file_path).map_err(to_error)?;
        if !metadata.is_file() {
            return Err(format!("Note does not exist: {}", path));
        }

        notes.push(read_note_file(path, &file_path, &metadata).map_err(to_error)?);
    }

    notes.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(notes)
}

#[tauri::command(rename_all = "camelCase")]
async fn create_workspace(
    parent_path: String,
    folder_name: String,
    apex_title: String,
) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_workspace_blocking(parent_path, folder_name, apex_title)
    })
    .await
    .map_err(to_error)?
}

fn create_workspace_blocking(
    parent_path: String,
    folder_name: String,
    apex_title: String,
) -> Result<Workspace, String> {
    let parent = PathBuf::from(parent_path);
    if !parent.is_dir() {
        return Err("Parent path is not a folder".into());
    }

    let folder_name = slugify(&folder_name).unwrap_or_else(|| "apex-notes".into());
    let root = unique_directory(&parent, &folder_name)?;
    let notes_root = root.join("notes");
    fs::create_dir_all(&notes_root).map_err(to_error)?;

    let apex_title = if apex_title.trim().is_empty() {
        "Apex".to_string()
    } else {
        apex_title.trim().to_string()
    };
    let apex_file = format!(
        "{}.md",
        slugify(&apex_title).unwrap_or_else(|| "apex".into())
    );
    let raw = format!(
        "---\ntitle: \"{}\"\nlevel: 0\nparent: null\n---\n\n# {}\n",
        escape_yaml(&apex_title),
        apex_title
    );

    fs::write(notes_root.join(&apex_file), raw).map_err(to_error)?;
    write_layout_file(&notes_root, &HashMap::new()).map_err(to_error)?;
    write_manifest_file(&notes_root, &[apex_file]).map_err(to_error)?;
    workspace_from_paths(root, notes_root)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_note(notes_path: String, path: String, raw: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_note_blocking(notes_path, path, raw))
        .await
        .map_err(to_error)?
}

fn write_note_blocking(notes_path: String, path: String, raw: String) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let file_path = safe_child_path(&notes_root, &path)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(to_error)?;
    }
    write_if_changed(&file_path, &raw).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn create_note(notes_path: String, path: String, raw: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_note_blocking(notes_path, path, raw))
        .await
        .map_err(to_error)?
}

fn create_note_blocking(notes_path: String, path: String, raw: String) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let file_path = safe_child_path(&notes_root, &path)?;
    if file_path.exists() {
        return Err("Note already exists".into());
    }
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(to_error)?;
    }
    fs::write(file_path, raw).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn create_notes(notes_path: String, notes: Vec<NoteWrite>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_notes_blocking(notes_path, notes))
        .await
        .map_err(to_error)?
}

fn create_notes_blocking(notes_path: String, notes: Vec<NoteWrite>) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let mut targets = Vec::with_capacity(notes.len());

    for note in notes {
        let file_path = safe_child_path(&notes_root, &note.path)?;
        if file_path.exists() {
            return Err(format!("Note already exists: {}", note.path));
        }
        targets.push((file_path, note.raw));
    }

    for (file_path, raw) in targets {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(to_error)?;
        }
        fs::write(file_path, raw).map_err(to_error)?;
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn write_manifest(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_manifest_blocking(notes_path, paths))
        .await
        .map_err(to_error)?
}

fn write_manifest_blocking(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    write_manifest_file(&notes_root, &paths).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_layout(
    notes_path: String,
    positions: HashMap<String, NotePosition>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_layout_blocking(notes_path, positions))
        .await
        .map_err(to_error)?
}

fn write_layout_blocking(
    notes_path: String,
    positions: HashMap<String, NotePosition>,
) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    write_layout_file(&notes_root, &positions).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_layout_patch(
    notes_path: String,
    updates: HashMap<String, Option<NotePosition>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_layout_patch_blocking(notes_path, updates))
        .await
        .map_err(to_error)?
}

fn write_layout_patch_blocking(
    notes_path: String,
    updates: HashMap<String, Option<NotePosition>>,
) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let mut positions = read_layout_file(&notes_root).map_err(to_error)?;

    for (path, position) in updates {
        if let Some(position) = position {
            positions.insert(path, position);
        } else {
            positions.remove(&path);
        }
    }

    write_layout_file(&notes_root, &positions).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn trash_note(notes_path: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash_note_blocking(notes_path, path))
        .await
        .map_err(to_error)?
}

fn trash_note_blocking(notes_path: String, path: String) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let file_path = safe_child_path(&notes_root, &path)?;
    if !file_path.is_file() {
        return Err("Note does not exist".into());
    }
    trash::delete(file_path).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn trash_notes(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash_notes_blocking(notes_path, paths))
        .await
        .map_err(to_error)?
}

fn trash_notes_blocking(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let mut files = Vec::with_capacity(paths.len());

    for path in paths {
        let file_path = safe_child_path(&notes_root, &path)?;
        if !file_path.is_file() {
            return Err(format!("Note does not exist: {}", path));
        }
        files.push(file_path);
    }

    for file_path in files {
        trash::delete(file_path).map_err(to_error)?;
    }

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_workspace,
            list_note_files,
            read_notes,
            create_workspace,
            write_note,
            create_note,
            create_notes,
            write_manifest,
            write_layout,
            write_layout_patch,
            trash_note,
            trash_notes
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

fn workspace_from_paths(root: PathBuf, notes_root: PathBuf) -> Result<Workspace, String> {
    let mut notes = Vec::new();
    collect_notes(&notes_root, &notes_root, &mut notes).map_err(to_error)?;
    notes.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    ensure_workspace_metadata(&notes_root, &notes).map_err(to_error)?;
    let positions = read_layout_file(&notes_root).map_err(to_error)?;

    let workspace_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Folder")
        .to_string();

    Ok(Workspace {
        root_path: root.to_string_lossy().into_owned(),
        notes_path: notes_root.to_string_lossy().into_owned(),
        workspace_name,
        positions,
        notes,
    })
}

fn collect_notes(base: &Path, current: &Path, notes: &mut Vec<NoteFile>) -> std::io::Result<()> {
    walk_markdown_files(base, current, &mut |relative, path, metadata| {
        notes.push(read_note_file(path_to_frontend(relative), path, metadata)?);
        Ok(())
    })
}

fn collect_note_statuses(
    base: &Path,
    current: &Path,
    statuses: &mut Vec<NoteFileStatus>,
) -> std::io::Result<()> {
    walk_markdown_files(base, current, &mut |relative, _path, metadata| {
        statuses.push(NoteFileStatus {
            path: path_to_frontend(relative),
            signature: file_signature(metadata),
            modified_ms: file_modified_ms(metadata),
            byte_len: metadata.len(),
        });
        Ok(())
    })
}

fn walk_markdown_files<F>(base: &Path, current: &Path, visit: &mut F) -> std::io::Result<()>
where
    F: FnMut(&Path, &Path, &fs::Metadata) -> std::io::Result<()>,
{
    if !current.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            walk_markdown_files(base, &path, visit)?;
            continue;
        }

        if !file_type.is_file() || !is_markdown_path(&path) {
            continue;
        }

        let metadata = entry.metadata()?;
        let relative = path.strip_prefix(base).unwrap_or(&path);
        visit(relative, &path, &metadata)?;
    }

    Ok(())
}

fn read_note_file(
    path: String,
    file_path: &Path,
    metadata: &fs::Metadata,
) -> std::io::Result<NoteFile> {
    Ok(NoteFile {
        path,
        raw: fs::read_to_string(file_path)?,
        signature: file_signature(metadata),
        modified_ms: file_modified_ms(metadata),
        byte_len: metadata.len(),
    })
}

fn file_signature(metadata: &fs::Metadata) -> String {
    let (seconds, nanos) = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or((0, 0));
    format!("{}:{}:{}", seconds, nanos, metadata.len())
}

fn file_modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn unique_directory(parent: &Path, requested_name: &str) -> Result<PathBuf, String> {
    for index in 0..1000 {
        let name = if index == 0 {
            requested_name.to_string()
        } else {
            format!("{}-{}", requested_name, index + 1)
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            fs::create_dir(&candidate).map_err(to_error)?;
            return Ok(candidate);
        }
    }

    Err("Could not find an available folder name".into())
}

fn safe_child_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::from(base);

    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => path.push(part),
            _ => return Err("Invalid note path".into()),
        }
    }

    Ok(path)
}

fn write_manifest_file(notes_root: &Path, paths: &[String]) -> std::io::Result<()> {
    fs::create_dir_all(notes_root)?;
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(paths).map_err(std::io::Error::other)?
    );
    write_if_changed(&notes_root.join("manifest.json"), &raw)
}

fn read_layout_file(notes_root: &Path) -> std::io::Result<HashMap<String, NotePosition>> {
    let raw = fs::read_to_string(notes_root.join("layout.json"));
    let data = match raw {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| HashMap::new()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(err) => return Err(err),
    };
    Ok(data)
}

fn ensure_workspace_metadata(notes_root: &Path, notes: &[NoteFile]) -> std::io::Result<()> {
    if !notes_root.join("manifest.json").exists() {
        let paths = notes
            .iter()
            .map(|note| note.path.clone())
            .collect::<Vec<_>>();
        write_manifest_file(notes_root, &paths)?;
    }

    if !notes_root.join("layout.json").exists() {
        write_layout_file(notes_root, &HashMap::new())?;
    }

    Ok(())
}

fn write_layout_file(
    notes_root: &Path,
    positions: &HashMap<String, NotePosition>,
) -> std::io::Result<()> {
    fs::create_dir_all(notes_root)?;
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(positions).map_err(std::io::Error::other)?
    );
    write_if_changed(&notes_root.join("layout.json"), &raw)
}

fn write_if_changed(path: &Path, raw: &str) -> std::io::Result<()> {
    match fs::read_to_string(path) {
        Ok(existing) if existing == raw => Ok(()),
        Ok(_) => fs::write(path, raw),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => fs::write(path, raw),
        Err(err) => Err(err),
    }
}

fn path_to_frontend(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str().map(ToOwned::to_owned),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn slugify(value: &str) -> Option<String> {
    let slug = value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

fn escape_yaml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn to_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
