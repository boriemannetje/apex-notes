use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteFile {
    path: String,
    raw: String,
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
fn create_workspace(
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
fn write_note(notes_path: String, path: String, raw: String) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let file_path = safe_child_path(&notes_root, &path)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(to_error)?;
    }
    fs::write(file_path, raw).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
fn create_note(notes_path: String, path: String, raw: String) -> Result<(), String> {
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
fn write_manifest(notes_path: String, paths: Vec<String>) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    write_manifest_file(&notes_root, &paths).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
fn write_layout(notes_path: String, positions: HashMap<String, NotePosition>) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    write_layout_file(&notes_root, &positions).map_err(to_error)
}

#[tauri::command(rename_all = "camelCase")]
fn trash_note(notes_path: String, path: String) -> Result<(), String> {
    let notes_root = PathBuf::from(notes_path);
    let file_path = safe_child_path(&notes_root, &path)?;
    if !file_path.is_file() {
        return Err("Note does not exist".into());
    }
    trash::delete(file_path).map_err(to_error)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_workspace,
            create_workspace,
            write_note,
            create_note,
            write_manifest,
            write_layout,
            trash_note
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
            collect_notes(base, &path, notes)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        let relative = path.strip_prefix(base).unwrap_or(&path);
        notes.push(NoteFile {
            path: path_to_frontend(relative),
            raw: fs::read_to_string(path)?,
        });
    }

    Ok(())
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
    fs::write(notes_root.join("manifest.json"), raw)
}

fn read_layout_file(notes_root: &Path) -> std::io::Result<HashMap<String, NotePosition>> {
    let raw = fs::read_to_string(notes_root.join("layout.json"));
    let data = match raw {
        Ok(raw) => {
            serde_json::from_str(&raw).unwrap_or_else(|_| HashMap::new())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(err) => return Err(err),
    };
    Ok(data)
}

fn ensure_workspace_metadata(notes_root: &Path, notes: &[NoteFile]) -> std::io::Result<()> {
    if !notes_root.join("manifest.json").exists() {
        let paths = notes.iter().map(|note| note.path.clone()).collect::<Vec<_>>();
        write_manifest_file(notes_root, &paths)?;
    }

    if !notes_root.join("layout.json").exists() {
        write_layout_file(notes_root, &HashMap::new())?;
    }

    Ok(())
}

fn write_layout_file(notes_root: &Path, positions: &HashMap<String, NotePosition>) -> std::io::Result<()> {
    fs::create_dir_all(notes_root)?;
    let raw = format!(
        "{}\n",
        serde_json::to_string_pretty(positions).map_err(std::io::Error::other)?
    );
    fs::write(notes_root.join("layout.json"), raw)
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
