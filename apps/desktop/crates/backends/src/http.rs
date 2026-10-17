use std::error::Error as _;

use reqwest::{Client, RequestBuilder, Response};
use serde::de::DeserializeOwned;

use crate::Error;

/// Sends a request, turning transport failures and non-2xx statuses into
/// [`Error::Backend`] with the TypeScript worker's messages.
pub(crate) async fn execute(client: &Client, request: RequestBuilder) -> Result<Response, Error> {
    let request =
        request.build().map_err(|error| Error::Backend(format!("Invalid request: {error}")))?;
    let target = format!("{} {}", request.method(), request.url());
    let response = client.execute(request).await.map_err(|error| {
        let cause = std::iter::successors(error.source(), |&e| e.source())
            .last()
            .map_or_else(|| error.to_string(), ToString::to_string);
        Error::Backend(format!("Transport error ({target}): {cause}"))
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(Error::Backend(format!("Backend returned {}: {body}", status.as_u16())))
}

pub(crate) async fn json<T: DeserializeOwned>(response: Response) -> Result<T, Error> {
    let body = response
        .bytes()
        .await
        .map_err(|error| Error::Backend(format!("Failed to read response body: {error}")))?;
    serde_json::from_slice(&body)
        .map_err(|error| Error::Backend(format!("Unexpected response body: {error}")))
}
