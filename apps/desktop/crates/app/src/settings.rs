//! Settings saved between launches. The token is kept in the OS keychain,
//! never here.

use std::fs;
use std::io;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use shoal_worker::{Availability, Config, Token};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// The worker socket URL; empty until set up.
    pub server: String,
    /// Empty keeps whatever name the server has stored.
    pub name: String,
    /// Opened from the menu; empty hides the item.
    pub dashboard: String,
    pub backends: Vec<String>,
    pub concurrency: NonZeroU32,
    pub availability: SavedAvailability,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: String::new(),
            name: String::new(),
            dashboard: String::new(),
            backends: vec!["http://localhost:11434".to_owned()],
            concurrency: NonZeroU32::MIN,
            availability: SavedAvailability::On,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SavedAvailability {
    On,
    Off,
    PausedUntil { unix_secs: u64 },
}

impl From<Availability> for SavedAvailability {
    fn from(availability: Availability) -> Self {
        match availability {
            Availability::On => Self::On,
            Availability::Off => Self::Off,
            Availability::PausedUntil(until) => Self::PausedUntil {
                unix_secs: until.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            },
        }
    }
}

impl From<SavedAvailability> for Availability {
    fn from(saved: SavedAvailability) -> Self {
        match saved {
            SavedAvailability::On => Self::On,
            SavedAvailability::Off => Self::Off,
            SavedAvailability::PausedUntil { unix_secs } => {
                let until = UNIX_EPOCH + Duration::from_secs(unix_secs);
                Self::PausedUntil(until).at(SystemTime::now())
            }
        }
    }
}

impl Settings {
    /// Falls back to defaults if nothing is saved or the file is unreadable,
    /// in which case it's set aside rather than overwritten.
    pub fn load() -> Self {
        let Some(path) = path() else { return Self::default() };
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                let aside = path.with_extension("json.unreadable");
                tracing::warn!(
                    "settings at {} are unreadable ({error}); moved to {}",
                    path.display(),
                    aside.display()
                );
                let _ = fs::rename(&path, aside);
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!("couldn't read settings at {}: {error}", path.display());
                Self::default()
            }
        }
    }

    /// Writes to a temporary file first so a crash can't leave half a file.
    pub fn save(&self) -> io::Result<()> {
        let path = path().ok_or_else(|| io::Error::other("no config directory"))?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let partial = path.with_extension("json.partial");
        fs::write(&partial, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(partial, path)
    }

    /// The worker config, once the server and token are both set.
    pub fn config(&self, token: Option<&str>) -> Option<Config> {
        let token = token.filter(|token| !token.is_empty())?;
        (!self.server.is_empty()).then(|| Config {
            server: self.server.clone(),
            token: Token::new(token.to_owned()),
            backends: self.backends.clone(),
            max_concurrent: self.concurrency,
            name: (!self.name.is_empty()).then(|| self.name.clone()),
        })
    }
}

/// `~/Library/Application Support/shoal/desktop.json` on macOS,
/// `%APPDATA%\shoal\desktop.json` on Windows.
fn path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("shoal").join("desktop.json"))
}
