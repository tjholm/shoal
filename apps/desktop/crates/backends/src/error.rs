/// A job failure. The message is sent to the server, which passes it on to
/// the API client.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("No configured backend serves model \"{model}\". {}", known_models(.known))]
    NoBackendForModel { model: String, known: Vec<String> },
    #[error("{0}")]
    Backend(String),
}

fn known_models(known: &[String]) -> String {
    if known.is_empty() {
        "No backends reported any models.".to_owned()
    } else {
        format!("Known models: {}", known.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_backend_messages_match_the_typescript_worker() {
        let error = |known: &[&str]| Error::NoBackendForModel {
            model: "nope".into(),
            known: known.iter().map(ToString::to_string).collect(),
        };
        assert_eq!(
            error(&["m1", "e1"]).to_string(),
            "No configured backend serves model \"nope\". Known models: m1, e1"
        );
        assert_eq!(
            error(&[]).to_string(),
            "No configured backend serves model \"nope\". No backends reported any models."
        );
    }
}
