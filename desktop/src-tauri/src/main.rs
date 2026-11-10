// Desktop shell for Shoal: a WebView2 window on the local server, plus tray and single instance.
// The server runs on the system Node (started through scripts/workbench.ps1 of a Shoal checkout). Quitting the
// shell stops it along with the agents; if the shell crashes or is killed, the server and agents keep running.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::fs::File;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SPLASH_HOST: &str = "tauri.localhost";
const NO_ROOT: &str = "没有选择 Shoal 仓库目录。\n\n桌面版只是外壳，服务端跑在本机 Node 24 上：先 git clone https://github.com/qianshuixia/Shoal，再点重试选择该目录（首次启动会自动 npm install）。";

static CONNECTING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);
// The Shoal checkout whose scripts\workbench.ps1 runs the server; set by connect().
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

fn port() -> u16 {
    std::env::var("WORKBENCH_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47800)
}

fn server_url() -> Url {
    Url::parse(&format!("http://127.0.0.1:{}/", port())).expect("valid server url")
}

fn is_root(dir: &Path) -> bool {
    dir.join("scripts").join("workbench.ps1").is_file()
}

// Where the picked checkout is remembered: %APPDATA%\dev.shoal.desktop\root.txt.
fn root_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("root.txt"))
}

// WORKBENCH_ROOT, else the checkout picked earlier, else the repo this shell was built from (a release built on
// CI points at the CI machine, so that one only counts if it exists here). None: ask the user.
fn find_root(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("WORKBENCH_ROOT") {
        return Some(PathBuf::from(dir));
    }
    let saved = root_file(app).and_then(|f| std::fs::read_to_string(f).ok()).map(|s| PathBuf::from(s.trim()));
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    saved.into_iter().chain([built]).find(|d| is_root(d))
}

// Folder picker until the user picks a Shoal checkout or cancels; the choice is saved for next time.
fn pick_root(app: &AppHandle, w: &WebviewWindow) -> Option<PathBuf> {
    call(w, "setStatus", "请选择 Shoal 仓库目录\n（git clone 下来的目录，里面有 scripts\\workbench.ps1）");
    loop {
        let dir = app.dialog().file().set_title("选择 Shoal 仓库目录").set_parent(w).blocking_pick_folder()?;
        let dir = dir.into_path().ok()?;
        if is_root(&dir) {
            if let Some(f) = root_file(app) {
                let _ = f.parent().map(std::fs::create_dir_all);
                let _ = std::fs::write(&f, dir.to_string_lossy().as_bytes());
            }
            return Some(dir);
        }
        let again = app
            .dialog()
            .message(format!("{} 里没有 scripts\\workbench.ps1，不是 Shoal 仓库。", dir.display()))
            .title("选择 Shoal 仓库目录")
            .kind(MessageDialogKind::Warning)
            .parent(w)
            .buttons(MessageDialogButtons::OkCancelCustom("重新选择".into(), "取消".into()))
            .blocking_show();
        if !again {
            return None;
        }
    }
}

// Minimal HTTP/1.0 client for the local server: 1.0 keeps Node from chunking the body. No Origin header, so the
// server's Origin check lets it through.
fn request(port: u16, method: &str, path: &str) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let body = if method == "POST" { "{}" } else { "" };
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let raw = String::from_utf8_lossy(&raw);
    let status = raw.split(' ').nth(1)?.parse().ok()?;
    Some((status, raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default()))
}

fn server_ready(port: u16) -> bool {
    matches!(request(port, "GET", "/api/state"), Some((200, _)))
}

// Agent sessions still running; None when the server is not reachable.
fn live_sessions(port: u16) -> Option<usize> {
    let (status, body) = request(port, "GET", "/api/state")?;
    if status != 200 {
        return None;
    }
    let state: serde_json::Value = serde_json::from_str(&body).ok()?;
    let sessions = state.get("sessions")?.as_array()?;
    Some(sessions.iter().filter(|s| s.get("status").and_then(|v| v.as_str()) != Some("exited")).count())
}

// workbench.ps1 owns npm install, rebuilding web/dist, port-conflict checks and the detached hidden server.
fn run_script(port: u16, args: &str) -> Result<(), String> {
    let root = ROOT.lock().unwrap().clone().ok_or("还没有选择 Shoal 仓库目录")?;
    let script = root.join("scripts").join("workbench.ps1");
    let script = script.canonicalize().map_err(|e| format!("找不到启动脚本 {}：{e}", script.display()))?;
    let script = script.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let cmd = format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '{}' {args} -Port {port}; exit $LASTEXITCODE",
        script.replace('\'', "''")
    );
    // Output goes to a file, not a pipe: the server started by Start-Process inherits these handles,
    // and a pipe would then never reach EOF while the server runs.
    let log_path = std::env::temp_dir().join("shoal-shell-start.log");
    let log = File::create(&log_path).map_err(|e| format!("无法创建 {}：{e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err)
        .status()
        .map_err(|e| format!("无法运行 powershell.exe：{e}"))?;
    if status.success() {
        return Ok(());
    }
    let text = std::fs::read(&log_path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    Err(format!("workbench.ps1 {args} 失败（退出码 {:?}）\n\n{}", status.code(), text.trim()))
}

// Same path as Ctrl+C on the server: it waits for freshly started claude sessions before killing them.
// Servers from before /api/shutdown existed answer 404; those get stopped by workbench.ps1 instead.
fn stop_server(port: u16) {
    if matches!(request(port, "POST", "/api/shutdown"), Some((202, _))) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while server_ready(port) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        if !server_ready(port) {
            return;
        }
    }
    let _ = run_script(port, "stop -Force");
}

// Window close and the tray's 退出 both end here: confirm if agents are running, stop the server, exit.
fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let port = port();
        let live = live_sessions(port);
        if let Some(n) = live.filter(|&n| n > 0) {
            show(&app);
            let mut dialog = app
                .dialog()
                .message(format!("还有 {n} 个 agent 会话在运行，退出会结束它们（之后可以在面板里续接）。"))
                .title("退出 Shoal")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("全部退出".into(), "取消".into()));
            if let Some(w) = app.get_webview_window("main") {
                dialog = dialog.parent(&w);
            }
            let ok = dialog.blocking_show();
            if !ok {
                QUITTING.store(false, Ordering::SeqCst);
                return;
            }
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        if live.is_some() {
            // Connected to a server that was already running: find the checkout for stop_server's fallback.
            let mut root = ROOT.lock().unwrap();
            if root.is_none() {
                *root = find_root(&app);
            }
            drop(root);
            stop_server(port);
        }
        app.exit(0);
    });
}

fn call(w: &WebviewWindow, func: &str, text: &str) {
    let _ = w.eval(format!("window.{func}({})", serde_json::Value::from(text)));
}

// Runs once the splash page has loaded: start the server if needed, then switch the window over to it.
fn connect(w: WebviewWindow) {
    if CONNECTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let port = port();
        let result = if server_ready(port) {
            Ok(())
        } else {
            let app = w.app_handle().clone();
            let root = ROOT.lock().unwrap().clone().or_else(|| find_root(&app)).or_else(|| pick_root(&app, &w));
            *ROOT.lock().unwrap() = root.clone();
            match root {
                None => Err(NO_ROOT.to_string()),
                Some(_) => {
                    call(&w, "setStatus", "正在启动工作台服务…\n前端有更新时会先构建，可能要几十秒");
                    run_script(port, "start -NoBrowser")
                }
            }
            .and_then(|()| {
                let deadline = Instant::now() + Duration::from_secs(10);
                while !server_ready(port) {
                    if Instant::now() > deadline {
                        return Err(format!("服务已启动，但 127.0.0.1:{port} 没有响应"));
                    }
                    std::thread::sleep(Duration::from_millis(300));
                }
                Ok(())
            })
        };
        match result {
            Ok(()) => {
                if let Err(e) = w.navigate(server_url()) {
                    call(&w, "setError", &format!("打开工作台失败：{e}"));
                }
            }
            Err(e) => call(&w, "setError", &e),
        }
        CONNECTING.store(false, Ordering::SeqCst);
    });
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn is_internal(url: &Url) -> bool {
    match url.host_str() {
        Some(SPLASH_HOST) => true,
        Some("127.0.0.1") => url.port() == Some(port()),
        _ => url.scheme() == "about",
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
    // For the shell's e2e: expose CDP. Tauri passes its own browser args, so WebView2 ignores
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; repeat Tauri's defaults when overriding them.
    if let Ok(p) = std::env::var("WORKBENCH_DEVTOOLS_PORT") {
        builder = builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={p}"
        ));
    }
    let w = builder
        .title("Shoal")
        .inner_size(1440.0, 900.0)
        .min_inner_size(800.0, 500.0)
        .visible(false)
        // Let drops reach the page: it saves dragged-in images and pastes their paths into the terminal.
        .disable_drag_drop_handler()
        // Web links in the terminal (window.open) go to the default browser instead of a bare popup.
        .on_new_window(move |url, _| {
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            let ok = is_internal(url);
            if !ok {
                open_external(&nav_app, url);
            }
            ok
        })
        .on_page_load(|w, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().host_str() == Some(SPLASH_HOST) {
                connect(w.clone());
            }
        })
        .build()?;

    // Hand Ctrl+F, Ctrl+P, Ctrl+R, F5 and the like to the page (and the terminal) instead of WebView2.
    w.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        if let Ok(settings) = pw.controller().CoreWebView2().and_then(|c| c.Settings()) {
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    })?;

    let quit_app = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            quit(&quit_app);
        }
    });
    w.show()?;
    Ok(w)
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "显示工作台", true, None::<&str>)?,
            &MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Shoal")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "browser" => open_external(app, &server_url()),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    // Back to the splash page, which reconnects (and restarts the server if it has stopped).
                    let _ = w.navigate(Url::parse(&format!("http://{SPLASH_HOST}/index.html")).unwrap());
                    show(app);
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The window is often hidden in the tray when the shell quits; always come back visible.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            create_window(app.handle())?;
            create_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Shoal");
}
