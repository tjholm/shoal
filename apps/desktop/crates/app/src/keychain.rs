//! The API token, kept in the macOS Keychain or Windows Credential Manager,
//! one per server URL.

use keyring_core::{Entry, Error};

const SERVICE: &str = "io.shoal.desktop";

/// Selects the platform's credential store. Call once at startup.
pub fn init() -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    keyring_core::set_default_store(apple_native_keyring_store::keychain::Store::new()?);
    #[cfg(windows)]
    keyring_core::set_default_store(windows_native_keyring_store::Store::new()?);
    Ok(())
}

pub fn token(server: &str) -> Result<Option<String>, Error> {
    match Entry::new(SERVICE, server)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn save_token(server: &str, token: &str) -> Result<(), Error> {
    Entry::new(SERVICE, server)?.set_password(token)
}
