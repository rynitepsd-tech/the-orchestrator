//! Engine sidecar supervision.
//!
//! Owns the lifetime of the bundled OMP engine process and the NDJSON protocol
//! channel to it. Responsibilities:
//!   * locate the bundled engine + Bun runtime inside the .app
//!   * spawn it with stdout as a pure protocol channel
//!   * pump stdout frames to the webview, stderr to the log
//!   * detect exit and surface it as an explicit, recoverable state
//!
//! An engine crash must never look like a hung UI, and an in-flight model
//! request must never be reported as still running when its process died.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Event name the frontend listens on for raw protocol frames.
pub const EVENT_FRAME: &str = "engine://frame";
/// Event name for supervisor-level state changes (spawned, crashed, restarting).
pub const EVENT_SUPERVISOR: &str = "engine://supervisor";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SupervisorEvent {
    Spawning {
        attempt: u32,
    },
    Ready,
    /// The engine exited. `code` is None when killed by a signal.
    Exited {
        code: Option<i32>,
        restarting: bool,
    },
    /// The engine could not be located or launched at all.
    LaunchFailed {
        message: String,
        detail: String,
    },
}

/// The live half of a spawned engine.
///
/// The `Child` stays here rather than moving into the reaper thread, so the
/// main thread can still kill a wedged process. The reaper polls `try_wait`
/// instead of blocking on `wait`, which keeps the lock uncontended.
pub struct EngineHandle {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(Clone)]
pub struct EngineSupervisor {
    inner: Arc<Mutex<EngineHandle>>,
    app: AppHandle,
    restarts: Arc<Mutex<u32>>,
}

/// Where the engine lives, in priority order.
///
/// A packaged build must be fully self-contained; the dev paths only ever apply
/// when running from a source checkout.
fn resolve_engine(app: &AppHandle) -> Result<(PathBuf, Vec<String>), String> {
    // 1. Packaged: Resources/engine/orchestrator-engine (a Bun single-file executable)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("engine").join("orchestrator-engine");
        if packaged.is_file() {
            return Ok((packaged, vec![]));
        }

        // 2. Packaged fallback: bundled Bun runtime + engine sources.
        let bun = resource_dir.join("engine").join("bun");
        let entry = resource_dir.join("engine").join("main.js");
        if bun.is_file() && entry.is_file() {
            return Ok((
                bun,
                vec!["run".into(), entry.to_string_lossy().into_owned()],
            ));
        }
    }

    // 3. Development: run the TypeScript entry with whatever bun is on PATH.
    if let Ok(dev_entry) = std::env::var("ORCHESTRATOR_ENGINE_ENTRY") {
        let bun = which_bun().unwrap_or_else(|| PathBuf::from("bun"));
        return Ok((bun, vec!["run".into(), dev_entry]));
    }

    Err("The bundled OMP engine could not be located inside the application.".into())
}

/// A Finder-launched .app inherits launchd's minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), so agent tools can't find Homebrew or
/// user-installed CLIs (gh, node, chrome wrappers, …). Append the standard
/// install locations that exist on disk so the engine — and every worker and
/// tool under it — sees the same commands a terminal would.
fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let mut parts: Vec<String> = base.split(':').map(String::from).collect();
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.bun/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
    ];
    for dir in candidates {
        // An empty $HOME yields paths like "/.bun/bin", which simply won't exist.
        if !parts.iter().any(|p| p == &dir) && PathBuf::from(&dir).is_dir() {
            parts.push(dir);
        }
    }
    parts.join(":")
}

fn which_bun() -> Option<PathBuf> {
    [
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".bun/bin/bun")),
        Some(PathBuf::from("/opt/homebrew/bin/bun")),
        Some(PathBuf::from("/usr/local/bin/bun")),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate.is_file())
}

impl EngineSupervisor {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(EngineHandle {
                child: None,
                stdin: None,
            })),
            app,
            restarts: Arc::new(Mutex::new(0)),
        }
    }

    /// Running means the write half is still open; the reaper clears it on exit.
    pub fn is_running(&self) -> bool {
        self.inner.lock().stdin.is_some()
    }

    /// Spawn the engine and start pumping its streams.
    pub fn spawn(&self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }

        let attempt = {
            let mut r = self.restarts.lock();
            *r += 1;
            *r
        };
        let _ = self
            .app
            .emit(EVENT_SUPERVISOR, SupervisorEvent::Spawning { attempt });

        let (program, args) = match resolve_engine(&self.app) {
            Ok(v) => v,
            Err(message) => {
                let detail = format!(
                    "arch={} os={} resource_dir={:?}",
                    std::env::consts::ARCH,
                    std::env::consts::OS,
                    self.app.path().resource_dir().ok()
                );
                let _ = self.app.emit(
                    EVENT_SUPERVISOR,
                    SupervisorEvent::LaunchFailed {
                        message: message.clone(),
                        detail,
                    },
                );
                return Err(message);
            }
        };

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("ORCHESTRATOR_VERSION", env!("CARGO_PKG_VERSION"))
            .env("PATH", enriched_path());

        let mut child = cmd.spawn().map_err(|e| {
            let message = "The bundled OMP engine could not start.".to_string();
            let detail = format!("program={:?} args={:?} error={e}", program, args);
            let _ = self.app.emit(
                EVENT_SUPERVISOR,
                SupervisorEvent::LaunchFailed {
                    message: message.clone(),
                    detail,
                },
            );
            message
        })?;

        let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;
        let stdin = child.stdin.take().ok_or("engine stdin unavailable")?;

        // stdout: protocol frames only, one JSON object per line.
        {
            let app = self.app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) if !l.trim().is_empty() => {
                            let _ = app.emit(EVENT_FRAME, l);
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            });
        }

        // stderr: diagnostics. Never parsed as protocol.
        {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    log::debug!("engine: {line}");
                }
            });
        }

        {
            let mut guard = self.inner.lock();
            guard.stdin = Some(stdin);
            guard.child = Some(child);
        }

        // Reaper: surface exit explicitly so sessions can be marked interrupted
        // rather than appearing to still be running against a dead process.
        {
            let app = self.app.clone();
            let inner = self.inner.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let exited = {
                    let mut guard = inner.lock();
                    match guard.child.as_mut() {
                        // Already reaped by shutdown(); nothing to report.
                        None => return,
                        Some(c) => match c.try_wait() {
                            Ok(Some(status)) => {
                                guard.child = None;
                                guard.stdin = None;
                                Some(status.code())
                            }
                            Ok(None) => None,
                            Err(_) => {
                                guard.child = None;
                                guard.stdin = None;
                                Some(None)
                            }
                        },
                    }
                };
                if let Some(code) = exited {
                    let _ = app.emit(
                        EVENT_SUPERVISOR,
                        SupervisorEvent::Exited {
                            code,
                            restarting: false,
                        },
                    );
                    return;
                }
            });
        }

        let _ = self.app.emit(EVENT_SUPERVISOR, SupervisorEvent::Ready);
        Ok(())
    }

    /// Write one protocol frame to the engine.
    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut guard = self.inner.lock();
        let stdin = guard.stdin.as_mut().ok_or("The engine is not running.")?;
        stdin
            .write_all(frame.as_bytes())
            .and_then(|_| {
                if frame.ends_with('\n') {
                    Ok(())
                } else {
                    stdin.write_all(b"\n")
                }
            })
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to the engine: {e}"))
    }

    /// Terminate the engine. Used on quit so no agent process is orphaned.
    ///
    /// Closing stdin is the graceful path: the engine's read loop ends and it
    /// disposes its sessions. The signal is a backstop for a wedged process.
    pub fn shutdown(&self) {
        // Closing the write half ends the engine's read loop, which disposes
        // its sessions and exits cleanly.
        {
            let mut guard = self.inner.lock();
            guard.stdin = None;
        }

        // Give it a moment to leave on its own terms.
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let mut guard = self.inner.lock();
            match guard.child.as_mut() {
                None => return,
                Some(c) => {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        guard.child = None;
                        return;
                    }
                }
            }
        }

        // Backstop for a wedged process, so quitting never orphans an engine.
        let mut guard = self.inner.lock();
        if let Some(c) = guard.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        guard.child = None;
    }
}
