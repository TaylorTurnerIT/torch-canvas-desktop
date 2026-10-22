#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use tauri::{Emitter, Manager, State};

#[derive(Clone)]
struct Grant {
    path: PathBuf,
    root: PathBuf,
    directory: bool,
}

#[derive(Default)]
struct Files(Mutex<HashMap<String, Grant>>);

// Paths the user chose through a native dialog or the system, kept so Recent can reopen them.
// Only paths recorded here can be reopened without another dialog.
const REMEMBERED_MAX: usize = 50;

fn read_remembered(store: &Path) -> Vec<String> {
    fs::read(store)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn remember_in(store: &Path, identity: &str) {
    let mut list = read_remembered(store);
    list.retain(|p| p != identity);
    list.insert(0, identity.to_owned());
    list.truncate(REMEMBERED_MAX);
    if let Some(dir) = store.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&list) {
        let _ = write_atomic(store, &bytes);
    }
}

fn remembered_store(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("recent-files.json"))
}

fn remember(app: &tauri::AppHandle, identity: &str) {
    if let Some(store) = remembered_store(app) {
        remember_in(&store, identity);
    }
}

// Files the system asked this app to open (Finder, `open -a`), waiting for the page to take them.
#[derive(Default)]
struct Opened(Mutex<Vec<Handle>>);

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
    app: tauri::AppHandle,
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
    let handle = files.grant(Grant {
        path,
        root,
        directory,
    })?;
    if !directory {
        remember(&app, &handle.identity);
    }
    Ok(Some(handle))
}

// Reopen a file the user chose in an earlier session. Only remembered paths qualify.
#[tauri::command]
fn native_reopen(
    identity: String,
    app: tauri::AppHandle,
    files: State<'_, Files>,
) -> Result<Option<Handle>, String> {
    let allowed = remembered_store(&app)
        .map(|store| read_remembered(&store))
        .unwrap_or_default();
    let path = PathBuf::from(&identity);
    if !allowed.contains(&identity) || !path.is_file() {
        return Ok(None);
    }
    let path = path.canonicalize().map_err(error)?;
    files
        .grant(Grant { root: path.clone(), path, directory: false })
        .map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    bytes: Vec<u8>,
    last_modified: u64,
}

#[tauri::command]
fn native_take_opened(opened: State<'_, Opened>) -> Result<Vec<Handle>, String> {
    Ok(std::mem::take(&mut *opened.0.lock().map_err(error)?))
}

// Opening a file from the system is the user's selection: grant exactly that file.
fn grant_opened(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let files = app.state::<Files>();
    let opened = app.state::<Opened>();
    for url in urls {
        let Ok(path) = url.to_file_path().and_then(|p| p.canonicalize().map_err(|_| ())) else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        let grant = Grant { root: path.clone(), path, directory: false };
        if let (Ok(handle), Ok(mut queue)) = (files.grant(grant), opened.0.lock()) {
            remember(app, &handle.identity);
            queue.push(handle);
        }
    }
    let _ = app.emit("torch-open", ());
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
    write_atomic(&checked_path(&g)?, &bytes)
}

// Replace the file in one step so a watcher such as marimo never reads a
// truncated notebook, and keep the existing permissions.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().ok_or("Missing filename")?.to_string_lossy();
    let temp = path.with_file_name(format!(".{name}.torch-canvas-{}", std::process::id()));
    let result = (|| {
        fs::write(&temp, bytes).map_err(error)?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp, meta.permissions()).map_err(error)?;
        }
        fs::rename(&temp, path).map_err(error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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

// ── marimo: run `marimo edit` for an opened notebook and hand the page to an iframe ──
struct Server {
    child: Child,
    url: String,
}

#[derive(Default)]
struct Marimo(Mutex<HashMap<String, Server>>);

#[derive(Serialize)]
struct MarimoInfo {
    url: String,
    project: String,
}

// The nearest ancestor with a pyproject.toml is the Python project the notebook belongs to.
fn project_root(file: &Path) -> Option<PathBuf> {
    file.parent()?
        .ancestors()
        .find(|dir| dir.join("pyproject.toml").is_file())
        .map(Path::to_path_buf)
}

// Arguments for `sh -c 'exec "$@"'`: the project's own environment when it has one.
fn marimo_command(root: Option<&Path>, file: &Path, port: u16) -> Result<Vec<String>, String> {
    let mut cmd: Vec<String> = match root {
        Some(root) => {
            let mut c: Vec<String> = vec!["uv".into(), "run".into()];
            if root.join("uv.lock").is_file() {
                c.push("--locked".into());
            }
            c.extend(["marimo".into(), "edit".into()]);
            c
        }
        None => vec!["marimo".into(), "edit".into()],
    };
    let file = file.to_str().ok_or("File path is not valid UTF-8")?;
    cmd.extend(
        [
            "--headless",
            "--no-token",
            "--watch",
            "--no-sandbox",
            "--skip-update-check",
            "--host",
            "127.0.0.1",
            "--port",
        ]
        .map(String::from),
    );
    cmd.push(port.to_string());
    cmd.push("--".into());
    cmd.push(file.into());
    Ok(cmd)
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(error)?;
    Ok(listener.local_addr().map_err(error)?.port())
}

fn stop_server(mut server: Server) {
    // `uv run` starts marimo as a child, so signal the whole process group.
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{}", server.child.id())])
        .status();
    let _ = server.child.kill();
    let _ = server.child.wait();
}

fn start_server(file: &Path) -> Result<(Server, PathBuf), String> {
    let root = project_root(file);
    let cwd = root
        .clone()
        .or_else(|| file.parent().map(Path::to_path_buf))
        .ok_or("Missing parent")?;
    let port = free_port()?;
    let args = marimo_command(root.as_deref(), file, port)?;
    // A login shell finds uv and marimo the way a terminal does; an app launched
    // from the Dock has only a minimal PATH.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-c", "exec \"$@\"", "marimo"])
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(error)?;
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    if let Some(stderr) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut log = log.lock().unwrap();
                log.push(line);
                if log.len() > 12 {
                    log.remove(0);
                }
            }
        });
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            let url = format!("http://127.0.0.1:{port}/");
            return Ok((Server { child, url }, cwd));
        }
        let exited = child.try_wait().map_err(error)?.is_some();
        if exited || Instant::now() > deadline {
            let tail = log.lock().unwrap().join("\n");
            stop_server(Server { child, url: String::new() });
            return Err(if exited {
                format!("marimo exited before it was ready.\n{tail}")
            } else {
                format!("marimo did not start within 3 minutes.\n{tail}")
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[tauri::command]
async fn marimo_start(
    id: String,
    files: State<'_, Files>,
    marimo: State<'_, Marimo>,
) -> Result<MarimoInfo, String> {
    let grant = files.get(&id)?;
    let path = checked_path(&grant)?;
    if grant.directory || path.extension().and_then(|e| e.to_str()) != Some("py") {
        return Err("marimo needs a Python notebook file".into());
    }
    {
        let mut map = marimo.0.lock().map_err(error)?;
        if let Some(server) = map.get_mut(&id) {
            if server.child.try_wait().map_err(error)?.is_none() {
                let project = project_root(&path).unwrap_or_else(|| path.clone());
                return Ok(MarimoInfo { url: server.url.clone(), project: project.display().to_string() });
            }
            map.remove(&id);
        }
    }
    let (server, cwd) = tauri::async_runtime::spawn_blocking(move || start_server(&path))
        .await
        .map_err(error)??;
    let info = MarimoInfo { url: server.url.clone(), project: cwd.display().to_string() };
    marimo.0.lock().map_err(error)?.insert(id, server);
    Ok(info)
}

#[tauri::command]
fn marimo_stop(id: String, marimo: State<'_, Marimo>) -> Result<(), String> {
    if let Some(server) = marimo.0.lock().map_err(error)?.remove(&id) {
        stop_server(server);
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Files::default())
        .manage(Marimo::default())
        .manage(Opened::default())
        .invoke_handler(tauri::generate_handler![
            native_pick,
            native_read,
            native_write,
            native_entries,
            native_child,
            native_take_opened,
            native_reopen,
            marimo_start,
            marimo_stop
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build Torch Canvas")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = &event {
                grant_opened(app, urls);
            }
            if let tauri::RunEvent::Exit = event {
                let servers: Vec<Server> = app
                    .state::<Marimo>()
                    .0
                    .lock()
                    .map(|mut map| map.drain().map(|(_, s)| s).collect())
                    .unwrap_or_default();
                for server in servers {
                    stop_server(server);
                }
            }
        });
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
    fn marimo_uses_the_notebooks_own_project() {
        let root = std::env::temp_dir().join(format!("torch-canvas-marimo-{}", std::process::id()));
        fs::create_dir_all(root.join("src/pkg")).unwrap();
        fs::write(root.join("pyproject.toml"), b"").unwrap();
        let file = root.join("src/pkg/notebook.py");
        assert_eq!(project_root(&file).as_deref(), Some(root.as_path()));
        let plain = marimo_command(Some(&root), &file, 9).unwrap();
        assert_eq!(plain[..4], ["uv", "run", "marimo", "edit"]);
        fs::write(root.join("uv.lock"), b"").unwrap();
        let locked = marimo_command(Some(&root), &file, 9).unwrap();
        assert_eq!(locked[..5], ["uv", "run", "--locked", "marimo", "edit"]);
        assert!(locked.contains(&"--no-token".to_string()) && locked.contains(&"--watch".to_string()));
        assert_eq!(locked[locked.len() - 2], "--");
        assert_eq!(marimo_command(None, &file, 9).unwrap()[..2], ["marimo", "edit"]);
        fs::remove_dir_all(root).unwrap();
    }

    // Real run: MARIMO_TEST_FILE=/path/to/notebook.py cargo test -- --ignored marimo_runs
    #[test]
    #[ignore]
    fn marimo_runs_and_stops() {
        let file = PathBuf::from(std::env::var("MARIMO_TEST_FILE").unwrap());
        let (server, _) = start_server(&file).unwrap();
        let mut page = TcpStream::connect(server.url.trim_start_matches("http://").trim_end_matches('/')).unwrap();
        std::io::Write::write_all(&mut page, b"GET / HTTP/1.0\r\n\r\n").unwrap();
        let mut body = String::new();
        std::io::Read::read_to_string(&mut page, &mut body).unwrap();
        assert!(body.starts_with("HTTP/1.1 200"), "{body}");
        let port = server.url.rsplit(':').next().unwrap().trim_end_matches('/').parse::<u16>().unwrap();
        stop_server(server);
        std::thread::sleep(Duration::from_millis(500));
        assert!(TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(200)).is_err());
    }

    #[test]
    fn remembered_paths_are_newest_first_deduplicated_and_capped() {
        let dir = std::env::temp_dir().join(format!("torch-canvas-store-{}", std::process::id()));
        let store = dir.join("recent-files.json");
        assert!(read_remembered(&store).is_empty());
        for i in 0..60 {
            remember_in(&store, &format!("/a/{i}.py"));
        }
        remember_in(&store, "/a/55.py");
        let list = read_remembered(&store);
        assert_eq!(list.len(), REMEMBERED_MAX);
        assert_eq!(list[0], "/a/55.py");
        assert_eq!(list.iter().filter(|p| *p == "/a/55.py").count(), 1);
        fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn atomic_write_replaces_contents_and_leaves_no_temp_file() {
        let root = std::env::temp_dir().join(format!("torch-canvas-atomic-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let file = root.join("notebook.py");
        fs::write(&file, b"old").unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(&file).unwrap();
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
