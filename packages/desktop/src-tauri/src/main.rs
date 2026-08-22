#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::io::Read;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

struct ServerState {
    url: Mutex<Option<String>>,
    token: Mutex<Option<String>>,
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

#[derive(Serialize)]
struct StartServerResult {
    url: String,
    token: String,
}

fn free_port(port: u16) {
    let port_str = port.to_string();
    if let Ok(out) = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port_str}")])
        .output()
    {
        if let Ok(pids) = String::from_utf8(out.stdout) {
            for pid in pids.lines().filter(|l| !l.is_empty()) {
                let _ = std::process::Command::new("kill")
                    .args(["-9", pid])
                    .output();
            }
        }
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Failed to open random source: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("Failed to read random token: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn parse_port_from_server_log(text: &str) -> Option<u16> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("server running at") {
            continue;
        }
        if let Some(rest) = lower
            .split("localhost:")
            .nth(1)
            .or_else(|| lower.split("127.0.0.1:").nth(1))
        {
            if let Ok(port) = rest
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .unwrap_or("")
                .parse()
            {
                return Some(port);
            }
        }
    }
    None
}

#[tauri::command]
async fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
    password: String,
) -> Result<StartServerResult, String> {
    if let Some(url) = state.url.lock().unwrap().as_ref() {
        let token = state.token.lock().unwrap().as_ref().cloned().unwrap_or_default();
        return Ok(StartServerResult { url: url.clone(), token });
    }

    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    free_port(3000);

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let admin_ui_path = resource_dir.join("admin-ui");

    let shell = app.shell();
    let token = random_token()?;

    let sidecar = shell
        .sidecar("swarm-server")
        .map_err(|e| format!("Sidecar not found: {}", e))?
        .args([
            &format!("--password={}", password),
            &format!("--admin-ui-path={}", admin_ui_path.display()),
        ])
        .env("SWARM_LOCAL_API_TOKEN", &token);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Spawn failed: {}", e))?;

    *state.child.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut port: u16 = 3000;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                stdout_buf.push_str(&text);
                if let Some(parsed_port) = parse_port_from_server_log(&stdout_buf) {
                    port = parsed_port;
                    break;
                }
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                stderr_buf.push_str(&text);
                if let Some(parsed_port) = parse_port_from_server_log(&stderr_buf) {
                    port = parsed_port;
                    break;
                }
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                return Err(format!("Server error: {}", err));
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                let code = status.code.unwrap_or(-1);
                let detail = if !stderr_buf.is_empty() {
                    stderr_buf.clone()
                } else {
                    stdout_buf.clone()
                };
                return Err(format!(
                    "Server exited with code {}\n{}",
                    code,
                    detail
                ));
            }
            _ => {}
        }
    }

    let url = format!("http://localhost:{}", port);
    *state.url.lock().unwrap() = Some(url.clone());
    *state.token.lock().unwrap() = Some(token.clone());
    Ok(StartServerResult { url, token })
}

#[tauri::command]
fn get_server_url(state: tauri::State<'_, ServerState>) -> Option<String> {
    state.url.lock().unwrap().clone()
}

#[tauri::command]
fn open_url(url: String) {
    let _ = std::process::Command::new("open").arg(&url).spawn();
}


fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(ServerState {
                url: Mutex::new(None),
                token: Mutex::new(None),
                child: Mutex::new(None),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let handle = window.app_handle().clone();
                std::thread::spawn(move || {
                    if let Some(state) = handle.try_state::<ServerState>() {
                        if let Some(child) = state.child.lock().ok().and_then(|mut g| g.take()) {
                            let _ = child.kill();
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![start_server, get_server_url, open_url])
        .run(tauri::generate_context!())
        .expect("error while running Swarm Desktop");
}
