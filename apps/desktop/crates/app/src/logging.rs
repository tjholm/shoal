//! Logs go to stderr and to a file: an app started at login has no terminal.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, fmt};

/// Past this the log is moved to `shoal.log.old` at startup.
const MAX_SIZE: u64 = 5 * 1024 * 1024;

pub fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"))
        // tungstenite traces the handshake request, whose URL holds the token.
        .add_directive("tungstenite=info".parse().expect("a valid directive"));
    let file = path().and_then(|path| {
        open(&path)
            .inspect_err(|error| eprintln!("couldn't open the log at {}: {error}", path.display()))
            .ok()
    });
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(io::stderr))
        .with(file.map(|file| fmt::layer().with_ansi(false).with_writer(Mutex::new(file))))
        .init();
}

/// `~/Library/Logs/Shoal/shoal.log` on macOS, `%LOCALAPPDATA%\shoal\logs`
/// on Windows.
fn path() -> Option<PathBuf> {
    let dir = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library").join("Logs").join("Shoal")
    } else {
        dirs::data_local_dir()?.join("shoal").join("logs")
    };
    Some(dir.join("shoal.log"))
}

fn open(path: &PathBuf) -> io::Result<File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_SIZE) {
        fs::rename(path, path.with_extension("log.old"))?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}
