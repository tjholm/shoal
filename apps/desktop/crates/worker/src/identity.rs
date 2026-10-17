//! The worker id and secret the server issues on first registration, stored
//! where and how the TypeScript CLI stores them so both share one identity.

use std::fmt;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity {
    pub worker_id: String,
    pub secret: String,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity").field("worker_id", &self.worker_id).finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("no home directory to store the worker identity in")]
    NoHome,
    #[error(
        "Failed to read worker identity at {}: {source}. Delete the file to re-register as a new worker.",
        path.display()
    )]
    Read { path: PathBuf, source: io::Error },
    #[error("Failed to write worker identity at {}: {source}", path.display())]
    Write { path: PathBuf, source: io::Error },
}

/// Where the TypeScript CLI keeps identities: `$XDG_STATE_HOME/shoal`,
/// defaulting to `~/.local/state/shoal` on every platform, macOS and Windows
/// included.
pub(crate) fn default_dir() -> Option<PathBuf> {
    let root = match std::env::var_os("XDG_STATE_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::home_dir()?.join(".local").join("state"),
    };
    Some(root.join("shoal"))
}

/// One file per server, named by a hash of its URL exactly as configured.
pub(crate) fn path(dir: Option<&Path>, server: &str) -> Result<PathBuf, Error> {
    Ok(dir.ok_or(Error::NoHome)?.join(file_name(server)))
}

fn file_name(server: &str) -> String {
    let hash = hex::encode(Sha256::digest(server.as_bytes()));
    format!("identity-{}.json", &hash[..16])
}

/// `None` when nothing is stored yet.
pub(crate) fn load(path: &Path) -> Result<Option<Identity>, Error> {
    let read = |source| Error::Read { path: path.to_owned(), source };
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| read(e.into())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(read(e)),
    }
}

/// Two-space indented with no trailing newline, in a directory only the
/// user can enter.
pub(crate) fn save(path: &Path, identity: &Identity) -> Result<(), Error> {
    let write = || -> io::Result<()> {
        if let Some(dir) = path.parent() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder.create(dir)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let json = serde_json::to_string_pretty(identity).map_err(io::Error::other)?;
        options.open(path)?.write_all(json.as_bytes())
    };
    write().map_err(|source| Error::Write { path: path.to_owned(), source })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_hashes_the_raw_server_url() {
        assert_eq!(
            file_name("wss://server.shoal.localhost/ws/workers"),
            "identity-ee6c2bca4fc6b963.json"
        );
    }

    #[test]
    fn identities_round_trip_in_the_typescript_format() {
        let dir = std::env::temp_dir().join(format!("shoal-identity-{}", std::process::id()));
        let path = dir.join("nested").join("identity.json");
        assert!(load(&path).unwrap().is_none());

        let identity = Identity { worker_id: "w-123".into(), secret: "sek".into() };
        save(&path, &identity).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"workerId\": \"w-123\",\n  \"secret\": \"sek\"\n}"
        );
        assert_eq!(load(&path).unwrap(), Some(identity));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        fs::write(&path, "{\"workerId\": 1}").unwrap();
        assert!(matches!(load(&path), Err(Error::Read { .. })));
        fs::remove_dir_all(dir).unwrap();
    }
}
