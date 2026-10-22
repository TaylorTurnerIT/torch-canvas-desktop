#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::State;

#[derive(Clone)]
struct Grant {
    path: PathBuf,
    root: PathBuf,
    directory: bool,
}

#[derive(Default)]
struct Files(Mutex<HashMap<String, Grant>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Handle {
    id: String,
    identity: String,
    name: String,
    kind: &'static str,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn checked_path(grant: &Grant) -> Result<PathBuf, String> {
    let resolved = if grant.path.exists() {
        grant.path.canonicalize().map_err(error)?
    } else {
        let parent = grant
            .path
            .parent()
            .ok_or("Missing parent")?
            .canonicalize()
            .map_err(error)?;
        parent.join(grant.path.file_name().ok_or("Missing filename")?)
    };
    if !resolved.starts_with(&grant.root) {
        return Err("Path is outside the selected location".into());
    }
    Ok(resolved)
}

fn child_path(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let mut parts = Path::new(name).components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err("Choose a single filename without directory components".into());
    }
    Ok(parent.join(name))
}

impl Files {
    fn grant(&self, grant: Grant) -> Result<Handle, String> {
        let identity = checked_path(&grant)?
            .to_str()
            .ok_or("File path is not valid UTF-8")?
            .to_owned();
        let mut map = self.0.lock().map_err(error)?;
        let id = map
            .iter()
            .find(|(_, g)| g.path == grant.path && g.root == grant.root)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| (map.len() + 1).to_string());
        let handle = Handle {
            id: id.clone(),
            identity,
            name: grant
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            kind: if grant.directory { "directory" } else { "file" },
        };
        map.insert(id, grant);
        Ok(handle)
    }

    fn get(&self, id: &str) -> Result<Grant, String> {
        let grant = self
            .0
            .lock()
            .map_err(error)?
            .get(id)
            .cloned()
            .ok_or("File permission expired; open it again")?;
        checked_path(&grant)?;
        Ok(grant)
    }
}

#[tauri::command]
async fn native_pick(
    mode: String,
    name: Option<String>,
    files: State<'_, Files>,
) -> Result<Option<Handle>, String> {
    let dialog = rfd::AsyncFileDialog::new();
    let picked = match mode.as_str() {
        "open" => {
            dialog
                .add_filter("Models and graphs", &["py", "json"])
                .pick_file()
                .await
        }
        "save" => {
            dialog
                .set_file_name(name.unwrap_or_else(|| "model.py".into()))
                .save_file()
                .await
        }
        "directory" => dialog.pick_folder().await,
        _ => return Err("Unknown dialog mode".into()),
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    let path = if path.exists() {
        path.canonicalize().map_err(error)?
    } else {
        path.parent()
            .ok_or("Missing parent")?
            .canonicalize()
            .map_err(error)?
            .join(path.file_name().ok_or("Missing filename")?)
    };
    let directory = mode == "directory";
    // A selected file grants only that exact path. A folder grants its descendants.
    let root = path.clone();
    files
        .grant(Grant {
            path,
            root,
            directory,
        })
        .map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    bytes: Vec<u8>,
    last_modified: u64,
}

#[tauri::command]
fn native_read(id: String, files: State<'_, Files>) -> Result<FileData, String> {
    let g = files.get(&id)?;
    let path = checked_path(&g)?;
    let metadata = fs::metadata(&path).map_err(error)?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        return Err("Choose a file smaller than 32 MiB".into());
    }
    let last_modified = metadata
        .modified()
        .map_err(error)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_millis() as u64;
    Ok(FileData {
        bytes: fs::read(path).map_err(error)?,
        last_modified,
    })
}

#[tauri::command]
fn native_write(id: String, bytes: Vec<u8>, files: State<'_, Files>) -> Result<(), String> {
    let g = files.get(&id)?;
    if g.directory {
        return Err("Cannot write a directory".into());
    }
    fs::write(checked_path(&g)?, bytes).map_err(error)
}

#[tauri::command]
fn native_entries(id: String, files: State<'_, Files>) -> Result<Vec<Handle>, String> {
    let g = files.get(&id)?;
    if !g.directory {
        return Err("Not a directory".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(checked_path(&g)?).map_err(error)? {
        let entry = entry.map_err(error)?;
        // Do not follow symlinks during project scans.
        let kind = entry.file_type().map_err(error)?;
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        entries.push(files.grant(Grant {
            path: entry.path(),
            root: g.root.clone(),
            directory: kind.is_dir(),
        })?);
    }
    Ok(entries)
}

#[tauri::command]
fn native_child(
    id: String,
    name: String,
    create: bool,
    files: State<'_, Files>,
) -> Result<Handle, String> {
    let g = files.get(&id)?;
    if !g.directory {
        return Err("Not a directory".into());
    }
    let path = child_path(&checked_path(&g)?, &name)?;
    let child = Grant {
        path,
        root: g.root,
        directory: false,
    };
    checked_path(&child)?;
    if create {
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&child.path)
            .map_err(error)?;
    } else if !child.path.is_file() {
        return Err("File not found".into());
    }
    files.grant(child)
}

fn main() {
    tauri::Builder::default()
        .manage(Files::default())
        .invoke_handler(tauri::generate_handler![
            native_pick,
            native_read,
            native_write,
            native_entries,
            native_child
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run Torch Canvas");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute_child_names() {
        for name in ["../secret", "a/b", "/tmp/secret", "..", ".", ""] {
            assert!(child_path(Path::new("/tmp"), name).is_err(), "{name}");
        }
        assert_eq!(
            child_path(Path::new("/tmp"), "model.py").unwrap(),
            Path::new("/tmp/model.py")
        );
    }

    #[test]
    fn rejects_ungranted_handle() {
        assert!(Files::default().get("1").is_err());
    }

    #[test]
    fn file_identity_matches_across_grants_but_distinguishes_same_basename() {
        let root =
            std::env::temp_dir().join(format!("torch-canvas-identity-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("other")).unwrap();
        fs::write(root.join("model.py"), b"first").unwrap();
        fs::write(root.join("other/model.py"), b"second").unwrap();
        let root = root.canonicalize().unwrap();
        let files = Files::default();
        let from_folder = files
            .grant(Grant {
                path: root.join("model.py"),
                root: root.clone(),
                directory: false,
            })
            .unwrap();
        let direct = files
            .grant(Grant {
                path: root.join("model.py"),
                root: root.join("model.py"),
                directory: false,
            })
            .unwrap();
        let other = files
            .grant(Grant {
                path: root.join("other/model.py"),
                root: root.clone(),
                directory: false,
            })
            .unwrap();
        assert_ne!(from_folder.id, direct.id);
        assert_eq!(from_folder.identity, direct.identity);
        assert_eq!(from_folder.name, other.name);
        assert_ne!(from_folder.identity, other.identity);
        fs::remove_file(root.join("model.py")).unwrap();
        fs::remove_file(root.join("other/model.py")).unwrap();
        fs::remove_dir(root.join("other")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = std::env::temp_dir().join(format!("torch-canvas-scope-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        let grant = Grant {
            path: root.join("escape/passwd"),
            root: root.canonicalize().unwrap(),
            directory: false,
        };
        assert!(checked_path(&grant).is_err());
        fs::remove_file(root.join("escape")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
