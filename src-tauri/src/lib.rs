use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    root_path: String,
    name: String,
    last_opened_at: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dy: Option<f64>,
}

#[tauri::command(rename_all = "camelCase")]
async fn read_workspace(root_path: String) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || read_workspace_blocking(root_path))
        .await
        .map_err(to_error)?
}

fn read_workspace_blocking(root_path: String) -> Result<Workspace, String> {
    let root = require_existing_dir(root_path, "Selected path is not a folder")?;

    let notes = root.join("notes");
    reject_symlink(&notes, "Notes folder cannot be a symlink").map_err(to_error)?;
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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;

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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;

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
async fn create_workspace(parent_path: String, folder_name: String) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_workspace_blocking(parent_path, folder_name)
    })
    .await
    .map_err(to_error)?
}

fn create_workspace_blocking(
    parent_path: String,
    folder_name: String,
) -> Result<Workspace, String> {
    let parent = require_existing_dir(parent_path, "Parent path is not a folder")?;

    let folder_name = slugify(&folder_name).unwrap_or_else(|| "apex-notes".into());
    let root = unique_directory(&parent, &folder_name)?;
    let notes_root = root.join("notes");
    fs::create_dir_all(&notes_root).map_err(to_error)?;

    write_layout_file(&notes_root, &HashMap::new()).map_err(to_error)?;
    write_manifest_file(&notes_root, &[]).map_err(to_error)?;
    workspace_from_paths(root, notes_root)
}

#[tauri::command(rename_all = "camelCase")]
fn default_project_location(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(to_error)?;
    let path = path.canonicalize().unwrap_or(path);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(rename_all = "camelCase")]
async fn rename_workspace(root_path: String, folder_name: String) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || rename_workspace_blocking(root_path, folder_name))
        .await
        .map_err(to_error)?
}

fn rename_workspace_blocking(root_path: String, folder_name: String) -> Result<Workspace, String> {
    let root = require_existing_dir(root_path, "Selected path is not a folder")?;
    let requested_name = slugify(&folder_name).ok_or("Folder name cannot be empty")?;
    let current_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Cannot rename this folder")?;

    if requested_name == current_name {
        return read_workspace_blocking(root.to_string_lossy().into_owned());
    }

    let parent = root.parent().ok_or("Cannot rename this folder")?;
    let target = parent.join(&requested_name);
    if target.exists() {
        return Err("A folder with that name already exists".into());
    }

    fs::rename(&root, &target).map_err(to_error)?;
    let notes = target.join("notes");
    reject_symlink(&notes, "Notes folder cannot be a symlink").map_err(to_error)?;
    let notes_root = if notes.is_dir() {
        notes
    } else {
        target.clone()
    };
    workspace_from_paths(target, notes_root)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_note(notes_path: String, path: String, raw: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_note_blocking(notes_path, path, raw))
        .await
        .map_err(to_error)?
}

fn write_note_blocking(notes_path: String, path: String, raw: String) -> Result<(), String> {
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let file_path = safe_markdown_child_path(&notes_root, &path)?;
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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let file_path = safe_markdown_child_path(&notes_root, &path)?;
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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let mut targets = Vec::with_capacity(notes.len());

    for note in notes {
        let file_path = safe_markdown_child_path(&notes_root, &note.path)?;
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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    for path in &paths {
        if !is_markdown_path(Path::new(path)) {
            return Err(format!(
                "Only Markdown notes can be listed in the manifest: {}",
                path
            ));
        }
        safe_markdown_child_path(&notes_root, path)?;
    }
    write_manifest_file(&notes_root, &paths).map_err(to_error)
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
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let mut positions = read_layout_file(&notes_root).map_err(to_error)?;

    for (path, position) in updates {
        safe_markdown_child_path(&notes_root, &path)?;
        if let Some(position) = position {
            positions.insert(path, position);
        } else {
            positions.remove(&path);
        }
    }

    write_layout_file(&notes_root, &positions).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
async fn trash_notes(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash_notes_blocking(notes_path, paths))
        .await
        .map_err(to_error)?
}

fn trash_notes_blocking(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let mut files = Vec::with_capacity(paths.len());

    for path in paths {
        let file_path = safe_markdown_child_path(&notes_root, &path)?;
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

#[tauri::command(rename_all = "camelCase")]
fn read_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let path = recent_projects_path(&app)?;
    read_recent_projects_file(&path)
}

#[tauri::command(rename_all = "camelCase")]
fn remember_recent_project(
    app: tauri::AppHandle,
    root_path: String,
    name: String,
) -> Result<Vec<RecentProject>, String> {
    let root = require_existing_dir(root_path, "Recent project path is not a folder")?;
    let root_path = root.to_string_lossy().into_owned();
    let name = if name.trim().is_empty() {
        workspace_display_name(&root_path)
    } else {
        name.trim().to_string()
    };

    let path = recent_projects_path(&app)?;
    let mut projects = read_recent_projects_file(&path)?;
    projects.retain(|project| project.root_path != root_path);
    projects.push(RecentProject {
        root_path,
        name,
        last_opened_at: now_ms(),
    });

    let projects = normalize_recent_projects(projects);
    write_recent_projects_file(&path, &projects)?;
    Ok(projects)
}

#[tauri::command(rename_all = "camelCase")]
fn forget_recent_project(
    app: tauri::AppHandle,
    root_path: String,
) -> Result<Vec<RecentProject>, String> {
    let path = recent_projects_path(&app)?;
    let mut projects = read_recent_projects_file(&path)?;
    projects.retain(|project| project.root_path != root_path);
    write_recent_projects_file(&path, &projects)?;
    Ok(projects)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_workspace,
            list_note_files,
            read_notes,
            create_workspace,
            default_project_location,
            rename_workspace,
            write_note,
            create_note,
            create_notes,
            write_manifest,
            write_layout_patch,
            trash_notes,
            read_recent_projects,
            remember_recent_project,
            forget_recent_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

fn recent_projects_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(to_error)?;
    fs::create_dir_all(&dir).map_err(to_error)?;
    Ok(dir.join("recent-projects.json"))
}

fn read_recent_projects_file(path: &Path) -> Result<Vec<RecentProject>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let projects = serde_json::from_str(&raw).unwrap_or_default();
            Ok(normalize_recent_projects(projects))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(to_error(err)),
    }
}

fn write_recent_projects_file(path: &Path, projects: &[RecentProject]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(to_error)?;
    }
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(&normalize_recent_projects(projects.to_vec()))
            .map_err(to_error)?
    );
    write_if_changed(path, &raw).map_err(to_error)
}

fn normalize_recent_projects(mut projects: Vec<RecentProject>) -> Vec<RecentProject> {
    for project in &mut projects {
        project.root_path = project.root_path.trim().to_string();
        project.name = project.name.trim().to_string();
        if project.name.is_empty() {
            project.name = workspace_display_name(&project.root_path);
        }
    }

    projects.retain(|project| !project.root_path.is_empty());
    projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));

    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(projects.len().min(8));
    for project in projects {
        if seen.insert(project.root_path.clone()) {
            normalized.push(project);
        }
        if normalized.len() == 8 {
            break;
        }
    }
    normalized
}

fn workspace_display_name(root_path: &str) -> String {
    Path::new(root_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Folder")
        .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn workspace_from_paths(root: PathBuf, notes_root: PathBuf) -> Result<Workspace, String> {
    let root = root.canonicalize().map_err(to_error)?;
    let notes_root = notes_root.canonicalize().map_err(to_error)?;
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
    let base = base.canonicalize().map_err(to_error)?;
    let mut path = base.clone();
    let mut components = Path::new(relative).components().peekable();

    if components.peek().is_none() {
        return Err("Invalid note path".into());
    }

    while let Some(component) = components.next() {
        match component {
            Component::Normal(part) => path.push(part),
            _ => return Err("Invalid note path".into()),
        }

        reject_symlink(&path, "Note path cannot include symlinks").map_err(to_error)?;
        if components.peek().is_some() {
            match fs::metadata(&path) {
                Ok(metadata) if !metadata.is_dir() => {
                    return Err("Note path parent is not a folder".into());
                }
                Ok(_) => {
                    let resolved = path.canonicalize().map_err(to_error)?;
                    if !resolved.starts_with(&base) {
                        return Err("Note path must stay inside the notes folder".into());
                    }
                    path = resolved;
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(to_error(err)),
            }
        }
    }

    if path.exists() {
        let resolved = path.canonicalize().map_err(to_error)?;
        if !resolved.starts_with(&base) {
            return Err("Note path must stay inside the notes folder".into());
        }
    }

    Ok(path)
}

fn safe_markdown_child_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if !is_markdown_path(Path::new(relative)) {
        return Err(format!(
            "Only Markdown note paths are allowed: {}",
            relative
        ));
    }
    safe_child_path(base, relative)
}

fn require_existing_dir(path: String, message: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(message.into());
    }
    path.canonicalize().map_err(to_error)
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
    let path = notes_root.join("layout.json");
    reject_symlink(&path, "Workspace metadata cannot be a symlink")?;
    let raw = fs::read_to_string(path);
    let data = match raw {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| HashMap::new()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(err) => return Err(err),
    };
    Ok(data)
}

fn ensure_workspace_metadata(notes_root: &Path, notes: &[NoteFile]) -> std::io::Result<()> {
    let manifest_path = notes_root.join("manifest.json");
    let layout_path = notes_root.join("layout.json");
    reject_symlink(&manifest_path, "Workspace metadata cannot be a symlink")?;
    reject_symlink(&layout_path, "Workspace metadata cannot be a symlink")?;

    if !manifest_path.exists() {
        let paths = notes
            .iter()
            .map(|note| note.path.clone())
            .collect::<Vec<_>>();
        write_manifest_file(notes_root, &paths)?;
    }

    if !layout_path.exists() {
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
    reject_symlink(path, "Workspace file cannot be a symlink")?;
    match fs::read_to_string(path) {
        Ok(existing) if existing == raw => Ok(()),
        Ok(_) => fs::write(path, raw),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => fs::write(path, raw),
        Err(err) => Err(err),
    }
}

fn reject_symlink(path: &Path, message: &str) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, message))
        }
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_notes_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let dir = env::temp_dir().join(format!("apex-notes-{}-{}", name, suffix));
        fs::create_dir_all(&dir).expect("create temp notes dir");
        dir
    }

    #[test]
    fn write_note_rejects_non_markdown_paths() {
        let notes = temp_notes_dir("non-md");
        let result = write_note_blocking(
            notes.to_string_lossy().into_owned(),
            "layout.json".to_string(),
            "{}".to_string(),
        );

        fs::remove_dir_all(notes).ok();
        assert!(result.is_err());
    }

    #[test]
    fn write_note_rejects_parent_traversal() {
        let notes = temp_notes_dir("parent-traversal");
        let result = write_note_blocking(
            notes.to_string_lossy().into_owned(),
            "../outside.md".to_string(),
            "# Outside\n".to_string(),
        );

        fs::remove_dir_all(notes).ok();
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn create_note_rejects_symlink_path_components() {
        use std::os::unix::fs::symlink;

        let notes = temp_notes_dir("symlink-notes");
        let outside = temp_notes_dir("symlink-outside");
        let link = notes.join("linked");
        symlink(&outside, &link).expect("create symlink");

        let result = create_note_blocking(
            notes.to_string_lossy().into_owned(),
            "linked/escape.md".to_string(),
            "# Escape\n".to_string(),
        );

        assert!(result.is_err());
        assert!(!outside.join("escape.md").exists());
        fs::remove_dir_all(notes).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn create_workspace_starts_without_an_apex_note() {
        let parent = temp_notes_dir("workspace-parent");

        let workspace = create_workspace_blocking(
            parent.to_string_lossy().into_owned(),
            "New Project".to_string(),
        )
        .expect("create workspace");

        assert!(workspace.notes.is_empty());
        assert!(Path::new(&workspace.notes_path)
            .join("manifest.json")
            .is_file());
        assert_eq!(
            fs::read_to_string(Path::new(&workspace.notes_path).join("manifest.json"))
                .expect("read manifest"),
            "[]\n"
        );
        assert!(!Path::new(&workspace.notes_path).join("apex.md").exists());

        fs::remove_dir_all(parent).ok();
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_rejects_symlink_notes_folder() {
        use std::os::unix::fs::symlink;

        let root = temp_notes_dir("symlink-root");
        let outside = temp_notes_dir("symlink-root-outside");
        symlink(&outside, root.join("notes")).expect("create notes symlink");

        let result = read_workspace_blocking(root.to_string_lossy().into_owned());

        assert!(result.is_err());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn normalize_recent_projects_dedupes_and_limits() {
        let mut projects = Vec::new();
        for index in 0..10 {
            projects.push(RecentProject {
                root_path: format!("/tmp/project-{}", index),
                name: format!("Project {}", index),
                last_opened_at: index,
            });
        }
        projects.push(RecentProject {
            root_path: "/tmp/project-9".to_string(),
            name: "Duplicate".to_string(),
            last_opened_at: 99,
        });

        let normalized = normalize_recent_projects(projects);

        assert_eq!(normalized.len(), 8);
        assert_eq!(normalized[0].root_path, "/tmp/project-9");
        assert_eq!(normalized[0].name, "Duplicate");
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

fn to_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
