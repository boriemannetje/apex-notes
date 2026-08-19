use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
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
    annotations: AnnotationDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotations_error: Option<String>,
}

const ANNOTATIONS_VERSION: u32 = 1;
const MAX_ANNOTATION_ITEMS: usize = 5_000;
const MAX_STROKE_POINTS: usize = 4_096;
const MAX_TOTAL_ANNOTATION_POINTS: usize = 100_000;
const MAX_ANNOTATION_NAME_CHARS: usize = 120;
const MAX_ANNOTATION_TEXT_CHARS: usize = 20_000;
const MAX_TOTAL_ANNOTATION_TEXT_CHARS: usize = 200_000;
const MAX_ANNOTATION_DOCUMENT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationDocument {
    version: u32,
    items: Vec<AnnotationItem>,
}

impl Default for AnnotationDocument {
    fn default() -> Self {
        Self {
            version: ANNOTATIONS_VERSION,
            items: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
enum AnnotationItem {
    Line(AnnotationLine),
    Square(AnnotationSquare),
    Circle(AnnotationCircle),
    Stroke(AnnotationStroke),
    Text(AnnotationText),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationLine {
    id: String,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationSquare {
    id: String,
    x: f64,
    y: f64,
    size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationCircle {
    id: String,
    cx: f64,
    cy: f64,
    radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationStroke {
    id: String,
    points: Vec<AnnotationPoint>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationPoint {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct AnnotationText {
    id: String,
    x: f64,
    y: f64,
    text: String,
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

const MAIN_PRODUCTION_DMG_URL_PREFIX: &str =
    "https://github.com/boriemannetje/apex-notes/releases/download/main-production/";
const MAIN_PRODUCTION_DMG_ASSET: &str = "apex-notes-main-macos-arm64.dmg";

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
async fn write_annotations(
    notes_path: String,
    annotations: AnnotationDocument,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_annotations_blocking(notes_path, annotations)
    })
    .await
    .map_err(to_error)?
}

fn write_annotations_blocking(
    notes_path: String,
    annotations: AnnotationDocument,
) -> Result<(), String> {
    let notes_root = require_existing_dir(notes_path, "Notes path is not a folder")?;
    let path = annotations_path(&notes_root);
    reject_symlink(&path, "Annotations file cannot be a symlink").map_err(to_error)?;

    // Never replace a sidecar that the app could not safely understand.
    if path.exists() {
        read_annotations_file(&notes_root)?;
    }

    validate_annotations(&annotations)?;
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(&annotations).map_err(to_error)?
    );
    write_if_changed(&path, &raw).map_err(to_error)
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

#[tauri::command(rename_all = "camelCase")]
async fn install_app_update(
    _app: tauri::AppHandle,
    release_commit: String,
) -> Result<(), String> {
    validate_release_commit(&release_commit)?;

    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            spawn_macos_update_installer(release_commit)
        })
        .await
        .map_err(to_error)??;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Automatic app updates are currently available for macOS builds only".into())
    }
}

fn main_production_dmg_url() -> String {
    format!("{}{}", MAIN_PRODUCTION_DMG_URL_PREFIX, MAIN_PRODUCTION_DMG_ASSET)
}

fn validate_release_commit(commit: &str) -> Result<(), String> {
    let trimmed = commit.trim();
    if (7..=40).contains(&trimmed.len()) && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err("Update release commit is invalid".into())
}

#[cfg(target_os = "macos")]
fn spawn_macos_update_installer(release_commit: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "apex-notes-update-{}-{}",
        std::process::id(),
        release_commit
    ));
    fs::create_dir_all(&temp_dir).map_err(to_error)?;
    let script_path = temp_dir.join("install-update.zsh");
    fs::write(&script_path, macos_update_script()).map_err(to_error)?;

    Command::new("/bin/zsh")
        .arg(&script_path)
        .arg(main_production_dmg_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(to_error)?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_update_script() -> &'static str {
    r#"#!/bin/zsh
set -euo pipefail

download_url="$1"
tmp="$(cd "$(dirname "$0")" && pwd)"
mount="$tmp/mount"

cleanup() {
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$mount"
curl -fL --retry 3 -o "$tmp/apex-notes.dmg" "$download_url"
hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$tmp/apex-notes.dmg" >/dev/null
codesign --verify --deep --strict "$mount/Apex Notes.app"

osascript -e 'tell application id "app.apex.notes" to quit' >/dev/null 2>&1 || true
sleep 1

rm -rf "/Applications/Apex Notes.app"
ditto "$mount/Apex Notes.app" "/Applications/Apex Notes.app"
codesign --verify --deep --strict "/Applications/Apex Notes.app"
open -n "/Applications/Apex Notes.app"
"#
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
            write_annotations,
            trash_notes,
            read_recent_projects,
            remember_recent_project,
            forget_recent_project,
            install_app_update
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
    let (annotations, annotations_error) = match read_annotations_file(&notes_root) {
        Ok(annotations) => (annotations, None),
        Err(error) => (AnnotationDocument::default(), Some(error)),
    };

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
        annotations,
        annotations_error,
        notes,
    })
}

fn annotations_path(notes_root: &Path) -> PathBuf {
    notes_root.join("annotations.json")
}

fn read_annotations_file(notes_root: &Path) -> Result<AnnotationDocument, String> {
    let path = annotations_path(notes_root);
    reject_symlink(&path, "Annotations file cannot be a symlink").map_err(to_error)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_ANNOTATION_DOCUMENT_BYTES => {
            return Err(format!(
                "annotations.json exceeds the {} byte limit",
                MAX_ANNOTATION_DOCUMENT_BYTES
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AnnotationDocument::default())
        }
        Err(error) => return Err(format!("Could not inspect annotations.json: {}", error)),
    }
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => return Err(format!("Could not read annotations.json: {}", error)),
    };
    let annotations: AnnotationDocument = serde_json::from_str(&raw)
        .map_err(|error| format!("annotations.json is invalid: {}", error))?;
    validate_annotations(&annotations)?;
    Ok(annotations)
}

fn validate_annotations(annotations: &AnnotationDocument) -> Result<(), String> {
    if annotations.version != ANNOTATIONS_VERSION {
        return Err(format!(
            "annotations.json version {} is not supported (expected version {})",
            annotations.version, ANNOTATIONS_VERSION
        ));
    }
    if annotations.items.len() > MAX_ANNOTATION_ITEMS {
        return Err(format!(
            "annotations.json contains more than {} items",
            MAX_ANNOTATION_ITEMS
        ));
    }
    let serialized_size = serde_json::to_vec(annotations).map_err(to_error)?.len() as u64;
    if serialized_size > MAX_ANNOTATION_DOCUMENT_BYTES {
        return Err(format!(
            "annotations.json exceeds the {} byte limit",
            MAX_ANNOTATION_DOCUMENT_BYTES
        ));
    }

    let mut ids = HashSet::with_capacity(annotations.items.len());
    let mut total_points = 0usize;
    let mut total_text_chars = 0usize;
    for item in &annotations.items {
        let id = annotation_id(item);
        if id.trim().is_empty() {
            return Err("Annotation IDs cannot be empty".into());
        }
        if !ids.insert(id) {
            return Err(format!("Duplicate annotation ID: {}", id));
        }

        match item {
            AnnotationItem::Line(line) => {
                validate_finite(&[line.x1, line.y1, line.x2, line.y2])?;
                if line.x1 == line.x2 && line.y1 == line.y2 {
                    return Err(format!("Line annotation {} has no length", line.id));
                }
                validate_name(line.name.as_deref())?;
                total_text_chars = add_annotation_text_chars(
                    total_text_chars,
                    line.name.as_deref().unwrap_or(""),
                )?;
            }
            AnnotationItem::Square(square) => {
                validate_finite(&[square.x, square.y, square.size])?;
                if square.size <= 0.0 {
                    return Err(format!(
                        "Square annotation {} has an invalid size",
                        square.id
                    ));
                }
                validate_name(square.name.as_deref())?;
                total_text_chars = add_annotation_text_chars(
                    total_text_chars,
                    square.name.as_deref().unwrap_or(""),
                )?;
            }
            AnnotationItem::Circle(circle) => {
                validate_finite(&[circle.cx, circle.cy, circle.radius])?;
                if circle.radius <= 0.0 {
                    return Err(format!(
                        "Circle annotation {} has an invalid radius",
                        circle.id
                    ));
                }
                validate_name(circle.name.as_deref())?;
                total_text_chars = add_annotation_text_chars(
                    total_text_chars,
                    circle.name.as_deref().unwrap_or(""),
                )?;
            }
            AnnotationItem::Stroke(stroke) => {
                if stroke.points.len() < 2 {
                    return Err(format!(
                        "Stroke annotation {} must contain at least two points",
                        stroke.id
                    ));
                }
                if stroke.points.len() > MAX_STROKE_POINTS {
                    return Err(format!(
                        "Stroke annotation {} contains more than {} points",
                        stroke.id, MAX_STROKE_POINTS
                    ));
                }
                total_points = total_points
                    .checked_add(stroke.points.len())
                    .ok_or("Annotation point count overflow")?;
                if total_points > MAX_TOTAL_ANNOTATION_POINTS {
                    return Err(format!(
                        "annotations.json contains more than {} stroke points",
                        MAX_TOTAL_ANNOTATION_POINTS
                    ));
                }
                for point in &stroke.points {
                    validate_finite(&[point.x, point.y])?;
                }
                if stroke
                    .points
                    .iter()
                    .skip(1)
                    .all(|point| point == &stroke.points[0])
                {
                    return Err(format!("Stroke annotation {} has no length", stroke.id));
                }
            }
            AnnotationItem::Text(text) => {
                validate_finite(&[text.x, text.y])?;
                if text.text.chars().count() > MAX_ANNOTATION_TEXT_CHARS {
                    return Err(format!(
                        "Text annotation {} exceeds {} characters",
                        text.id, MAX_ANNOTATION_TEXT_CHARS
                    ));
                }
                total_text_chars = add_annotation_text_chars(total_text_chars, &text.text)?;
            }
        }
    }
    Ok(())
}

fn add_annotation_text_chars(current: usize, value: &str) -> Result<usize, String> {
    let total = current
        .checked_add(value.chars().count())
        .ok_or("Annotation text count overflow")?;
    if total > MAX_TOTAL_ANNOTATION_TEXT_CHARS {
        return Err(format!(
            "annotations.json contains more than {} text characters",
            MAX_TOTAL_ANNOTATION_TEXT_CHARS
        ));
    }
    Ok(total)
}

fn annotation_id(item: &AnnotationItem) -> &str {
    match item {
        AnnotationItem::Line(item) => &item.id,
        AnnotationItem::Square(item) => &item.id,
        AnnotationItem::Circle(item) => &item.id,
        AnnotationItem::Stroke(item) => &item.id,
        AnnotationItem::Text(item) => &item.id,
    }
}

fn validate_name(name: Option<&str>) -> Result<(), String> {
    if name
        .map(|name| name.chars().count() > MAX_ANNOTATION_NAME_CHARS)
        .unwrap_or(false)
    {
        return Err(format!(
            "Annotation names cannot exceed {} characters",
            MAX_ANNOTATION_NAME_CHARS
        ));
    }
    Ok(())
}

fn validate_finite(values: &[f64]) -> Result<(), String> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err("Annotation geometry must contain only finite numbers".into())
    }
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
        assert_eq!(workspace.annotations, AnnotationDocument::default());
        assert!(workspace.annotations_error.is_none());
        assert!(!Path::new(&workspace.notes_path)
            .join("annotations.json")
            .exists());

        fs::remove_dir_all(parent).ok();
    }

    fn sample_annotations() -> AnnotationDocument {
        AnnotationDocument {
            version: ANNOTATIONS_VERSION,
            items: vec![
                AnnotationItem::Line(AnnotationLine {
                    id: "line-1".into(),
                    x1: 1.0,
                    y1: 2.0,
                    x2: 3.0,
                    y2: 4.0,
                    name: Some("Connector".into()),
                }),
                AnnotationItem::Stroke(AnnotationStroke {
                    id: "stroke-1".into(),
                    points: vec![
                        AnnotationPoint { x: 0.0, y: 0.0 },
                        AnnotationPoint { x: 1.0, y: 1.0 },
                    ],
                }),
            ],
        }
    }

    #[test]
    fn missing_annotations_load_empty_without_creating_a_file() {
        let notes = temp_notes_dir("annotations-missing");

        let result = read_annotations_file(&notes).expect("load missing annotations");

        assert_eq!(result, AnnotationDocument::default());
        assert!(!notes.join("annotations.json").exists());
        fs::remove_dir_all(notes).ok();
    }

    #[test]
    fn annotations_round_trip_through_the_native_writer() {
        let notes = temp_notes_dir("annotations-round-trip");
        let annotations = sample_annotations();

        write_annotations_blocking(notes.to_string_lossy().into_owned(), annotations.clone())
            .expect("write annotations");

        assert_eq!(
            read_annotations_file(&notes).expect("read annotations"),
            annotations
        );
        let raw = fs::read_to_string(notes.join("annotations.json")).expect("read sidecar");
        assert!(raw.contains("\"type\": \"line\""));
        assert!(raw.ends_with('\n'));
        fs::remove_dir_all(notes).ok();
    }

    #[test]
    fn malformed_annotations_are_reported_and_never_overwritten() {
        let notes = temp_notes_dir("annotations-malformed");
        let path = notes.join("annotations.json");
        let malformed = b"{ definitely not json }";
        fs::write(&path, malformed).expect("write malformed sidecar");

        assert!(read_annotations_file(&notes).is_err());
        assert!(write_annotations_blocking(
            notes.to_string_lossy().into_owned(),
            sample_annotations()
        )
        .is_err());
        assert_eq!(fs::read(&path).expect("reread sidecar"), malformed);
        fs::remove_dir_all(notes).ok();
    }

    #[test]
    fn newer_annotations_are_reported_and_never_overwritten() {
        let notes = temp_notes_dir("annotations-newer");
        let path = notes.join("annotations.json");
        let newer = br#"{"version":2,"items":[]}"#;
        fs::write(&path, newer).expect("write newer sidecar");

        let error = read_annotations_file(&notes).expect_err("reject newer version");
        assert!(error.contains("not supported"));
        assert!(write_annotations_blocking(
            notes.to_string_lossy().into_owned(),
            sample_annotations()
        )
        .is_err());
        assert_eq!(fs::read(&path).expect("reread sidecar"), newer);
        fs::remove_dir_all(notes).ok();
    }

    #[test]
    fn invalid_annotations_do_not_prevent_the_workspace_from_opening() {
        let root = temp_notes_dir("annotations-workspace-error");
        let notes = root.join("notes");
        fs::create_dir(&notes).expect("create notes folder");
        fs::write(notes.join("annotations.json"), "not json").expect("write invalid sidecar");

        let workspace = workspace_from_paths(root.clone(), notes).expect("open workspace");

        assert_eq!(workspace.annotations, AnnotationDocument::default());
        assert!(workspace
            .annotations_error
            .as_deref()
            .is_some_and(|error| error.contains("invalid")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn annotation_validation_enforces_ids_geometry_and_limits() {
        let mut duplicate = sample_annotations();
        if let AnnotationItem::Stroke(stroke) = &mut duplicate.items[1] {
            stroke.id = "line-1".into();
        }
        assert!(validate_annotations(&duplicate).is_err());

        let invalid_geometry = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Circle(AnnotationCircle {
                id: "circle-1".into(),
                cx: 0.0,
                cy: 0.0,
                radius: 0.0,
                name: None,
            })],
        };
        assert!(validate_annotations(&invalid_geometry).is_err());

        let oversized_name = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Square(AnnotationSquare {
                id: "square-1".into(),
                x: 0.0,
                y: 0.0,
                size: 1.0,
                name: Some("n".repeat(MAX_ANNOTATION_NAME_CHARS + 1)),
            })],
        };
        assert!(validate_annotations(&oversized_name).is_err());

        let oversized_text = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Text(AnnotationText {
                id: "text-1".into(),
                x: 0.0,
                y: 0.0,
                text: "t".repeat(MAX_ANNOTATION_TEXT_CHARS + 1),
            })],
        };
        assert!(validate_annotations(&oversized_text).is_err());

        let too_many_points = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Stroke(AnnotationStroke {
                id: "stroke-1".into(),
                points: (0..=MAX_STROKE_POINTS)
                    .map(|index| AnnotationPoint {
                        x: index as f64,
                        y: 0.0,
                    })
                    .collect(),
            })],
        };
        assert!(validate_annotations(&too_many_points).is_err());

        let strokes = (0..25)
            .map(|stroke_index| {
                AnnotationItem::Stroke(AnnotationStroke {
                    id: format!("stroke-{}", stroke_index),
                    points: (0..MAX_STROKE_POINTS)
                        .map(|point_index| AnnotationPoint {
                            x: point_index as f64,
                            y: stroke_index as f64,
                        })
                        .collect(),
                })
            })
            .collect();
        let too_many_total_points = AnnotationDocument {
            version: 1,
            items: strokes,
        };
        assert!(validate_annotations(&too_many_total_points).is_err());

        let non_finite = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Text(AnnotationText {
                id: "text-infinite".into(),
                x: f64::INFINITY,
                y: 0.0,
                text: "invalid".into(),
            })],
        };
        assert!(validate_annotations(&non_finite).is_err());

        let item = AnnotationItem::Text(AnnotationText {
            id: "text".into(),
            x: 0.0,
            y: 0.0,
            text: String::new(),
        });
        let too_many_items = AnnotationDocument {
            version: 1,
            items: vec![item; MAX_ANNOTATION_ITEMS + 1],
        };
        assert!(validate_annotations(&too_many_items).is_err());

        let exact_unicode_name = "😀".repeat(MAX_ANNOTATION_NAME_CHARS);
        let unicode_name = AnnotationDocument {
            version: 1,
            items: vec![AnnotationItem::Circle(AnnotationCircle {
                id: "unicode".into(),
                cx: 0.0,
                cy: 0.0,
                radius: 1.0,
                name: Some(exact_unicode_name),
            })],
        };
        assert!(validate_annotations(&unicode_name).is_ok());

        let too_much_text = AnnotationDocument {
            version: 1,
            items: (0..11)
                .map(|index| {
                    AnnotationItem::Text(AnnotationText {
                        id: format!("text-{}", index),
                        x: index as f64,
                        y: 0.0,
                        text: "t".repeat(MAX_ANNOTATION_TEXT_CHARS),
                    })
                })
                .collect(),
        };
        assert!(validate_annotations(&too_much_text).is_err());
    }

    #[test]
    fn annotation_validation_matches_shared_frontend_fixtures() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/annotations-parity.json"))
                .expect("parse parity fixtures");
        let valid: AnnotationDocument =
            serde_json::from_value(fixtures["valid"].clone()).expect("parse valid fixture");
        validate_annotations(&valid).expect("validate shared valid fixture");
        assert_eq!(annotation_id(&valid.items[0]), "  line-😀  ");
        if let AnnotationItem::Line(line) = &valid.items[0] {
            assert_eq!(line.name.as_deref(), Some("  external 😀 name  "));
        } else {
            panic!("expected line fixture");
        }
        for invalid in fixtures["invalid"].as_array().expect("invalid fixtures") {
            match serde_json::from_value::<AnnotationDocument>(invalid.clone()) {
                Ok(document) => assert!(validate_annotations(&document).is_err()),
                Err(_) => {}
            }
        }
    }

    #[test]
    fn oversized_annotation_files_are_rejected_before_reading() {
        let notes = temp_notes_dir("annotations-oversized");
        let path = notes.join("annotations.json");
        fs::write(
            &path,
            vec![b' '; MAX_ANNOTATION_DOCUMENT_BYTES as usize + 1],
        )
        .expect("write oversized sidecar");

        let error = read_annotations_file(&notes).expect_err("reject oversized sidecar");
        assert!(error.contains("byte limit"));
        fs::remove_dir_all(notes).ok();
    }

    #[test]
    fn annotation_schema_rejects_unknown_fields() {
        let raw = r#"{"version":1,"items":[{"type":"text","id":"t","x":0,"y":0,"text":"ok","extra":true}]}"#;
        assert!(serde_json::from_str::<AnnotationDocument>(raw).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn annotation_sidecar_symlinks_are_never_read_or_written() {
        use std::os::unix::fs::symlink;

        let notes = temp_notes_dir("annotations-symlink");
        let outside = temp_notes_dir("annotations-symlink-outside");
        let target = outside.join("annotations.json");
        let original = b"outside file";
        fs::write(&target, original).expect("write outside file");
        symlink(&target, notes.join("annotations.json")).expect("create sidecar symlink");

        assert!(read_annotations_file(&notes).is_err());
        assert!(write_annotations_blocking(
            notes.to_string_lossy().into_owned(),
            sample_annotations()
        )
        .is_err());
        assert_eq!(fs::read(target).expect("read outside file"), original);
        fs::remove_dir_all(notes).ok();
        fs::remove_dir_all(outside).ok();
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

    #[test]
    fn builds_main_production_update_download_url_in_native_code() {
        assert_eq!(
            main_production_dmg_url(),
            "https://github.com/boriemannetje/apex-notes/releases/download/main-production/apex-notes-main-macos-arm64.dmg"
        );
    }

    #[test]
    fn validates_release_commit_shape() {
        assert!(validate_release_commit("0192607e6d6aad1d69296c8f5e78bd113c2355f5").is_ok());
        assert!(validate_release_commit("0192607").is_ok());
        assert!(validate_release_commit("not-a-sha").is_err());
        assert!(validate_release_commit("").is_err());
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
