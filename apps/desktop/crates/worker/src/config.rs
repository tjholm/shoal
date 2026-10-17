use std::fmt;
use std::num::NonZeroU32;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// What a worker connects to and serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The worker socket URL, e.g. `wss://shoal.example.com/ws/workers`. Used
    /// verbatim: it also keys the stored identity.
    pub server: String,
    pub token: Token,
    /// Backend base URLs, in routing order.
    pub backends: Vec<String>,
    /// Advertised to the server, which enforces it.
    pub max_concurrent: NonZeroU32,
    /// Overwrites the name the server has stored; `None` keeps it.
    pub name: Option<String>,
}

/// An API key. Never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    #[must_use]
    pub fn new(token: String) -> Self {
        Self(token)
    }

    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

/// What JavaScript's `encodeURIComponent` escapes.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

impl Config {
    /// The server URL with the token appended as a query parameter, which is
    /// the only way the server accepts it. Contains the secret: never log it.
    pub(crate) fn socket_url(&self) -> String {
        let separator = if self.server.contains('?') { '&' } else { '?' };
        let token = utf8_percent_encode(self.token.expose(), URI_COMPONENT);
        format!("{}{separator}token={token}", self.server)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(server: &str, token: &str) -> Config {
        Config {
            server: server.into(),
            token: Token::new(token.into()),
            backends: vec![],
            max_concurrent: NonZeroU32::MIN,
            name: None,
        }
    }

    #[test]
    fn the_token_is_encoded_like_encode_uri_component() {
        assert_eq!(
            config("wss://h/ws", "a b+c/!*").socket_url(),
            "wss://h/ws?token=a%20b%2Bc%2F!*"
        );
        assert_eq!(config("wss://h/ws?x=1", "t").socket_url(), "wss://h/ws?x=1&token=t");
    }

    #[test]
    fn the_token_is_never_printed() {
        assert!(!format!("{:?}", config("wss://h", "hunter2")).contains("hunter2"));
    }
}
