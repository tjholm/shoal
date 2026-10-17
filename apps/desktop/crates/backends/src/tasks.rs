//! The single-response tasks: embeddings, image generation and speech.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use reqwest::Client;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use shoal_protocol::{GeneratedImage, ImageResponseFormat, InferOptions};

use crate::http::{execute, json};
use crate::{Error, Finish, Output};

#[derive(Debug, Deserialize)]
struct Embeddings {
    data: Vec<EmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f64>,
}

/// Only the first vector is returned, even for array input.
pub(crate) async fn embedding(
    client: &Client,
    url: &str,
    model: &str,
    input: &Value,
    mut emit: impl FnMut(Output),
) -> Result<Finish, Error> {
    let request = client
        .post(format!("{url}/v1/embeddings"))
        .json(&serde_json::json!({ "model": model, "input": input }));
    let response: Embeddings = json(execute(client, request).await?).await?;
    let vector =
        response.data.into_iter().next().ok_or_else(|| {
            Error::Backend("Unexpected response body: no embedding in `data`".into())
        })?;
    emit(Output::Embedding(vector.embedding));
    Ok(Finish::STOP)
}

#[derive(Debug, Serialize)]
struct ImageBody<'a> {
    model: &'a str,
    prompt: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    n: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<&'a ImageResponseFormat>,
}

#[derive(Debug, Deserialize)]
struct Images {
    data: Vec<RawImage>,
}

#[derive(Debug, Deserialize)]
struct RawImage {
    b64_json: Option<String>,
    url: Option<String>,
    revised_prompt: Option<String>,
}

pub(crate) async fn image(
    client: &Client,
    url: &str,
    model: &str,
    input: &Value,
    options: &InferOptions,
    mut emit: impl FnMut(Output),
) -> Result<Finish, Error> {
    let image = options.image.as_ref();
    let body = ImageBody {
        model,
        prompt: input,
        size: image.and_then(|o| o.size.as_deref()),
        n: image.and_then(|o| o.n),
        quality: image.and_then(|o| o.quality.as_deref()),
        style: image.and_then(|o| o.style.as_deref()),
        response_format: image.and_then(|o| o.response_format.as_ref()),
    };
    let request = client.post(format!("{url}/v1/images/generations")).json(&body);
    let response: Images = json(execute(client, request).await?).await?;
    emit(Output::Images(
        response
            .data
            .into_iter()
            .map(|image| GeneratedImage {
                b64: image.b64_json,
                url: image.url,
                revised_prompt: image.revised_prompt,
            })
            .collect(),
    ));
    Ok(Finish::STOP)
}

#[derive(Debug, Serialize)]
struct SpeechBody<'a> {
    model: &'a str,
    input: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<&'a Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<&'a str>,
}

pub(crate) async fn speech(
    client: &Client,
    url: &str,
    model: &str,
    input: &Value,
    options: &InferOptions,
    mut emit: impl FnMut(Output),
) -> Result<Finish, Error> {
    let tts = options.tts.as_ref();
    let format = tts.and_then(|o| o.response_format.as_deref());
    let body = SpeechBody {
        model,
        input,
        voice: tts.and_then(|o| o.voice.as_deref()),
        response_format: format,
        speed: tts.and_then(|o| o.speed.as_ref()),
        instructions: tts.and_then(|o| o.instructions.as_deref()),
    };
    let request = client.post(format!("{url}/v1/audio/speech")).json(&body);
    let response = execute(client, request).await?;
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map_or_else(|| mime_for(format).to_owned(), ToOwned::to_owned);
    let audio = response
        .bytes()
        .await
        .map_err(|error| Error::Backend(format!("Failed to read response body: {error}")))?;
    emit(Output::Audio { b64: STANDARD.encode(&audio), mime_type });
    Ok(Finish::STOP)
}

/// The MIME type for a requested format, for backends that send no
/// `Content-Type`.
fn mime_for(format: Option<&str>) -> &'static str {
    match format {
        Some("mp3") => "audio/mpeg",
        Some("opus") => "audio/opus",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("pcm") => "audio/pcm",
        _ => "application/octet-stream",
    }
}
