//! Wire types for the worker socket between a shoal server and a worker.
//!
//! The source of truth is `packages/protocol/index.ts`; these types mirror it
//! field for field. Messages are JSON objects tagged by `type`, with camelCase
//! fields, and optional fields are omitted rather than sent as `null`.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

/// An inference task, as sent on `infer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTask {
    Chat,
    Embedding,
    Image,
    Tts,
}

/// A model's primary modality.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelPurpose {
    Chat,
    Embedding,
    Image,
    Tts,
}

/// A feature flag on top of a model's purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelCapability {
    Tools,
    Vision,
    Thinking,
}

/// A model a worker advertises. `None` means the worker couldn't tell, which
/// the server treats as "permit"; a present value is used as is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<ModelPurpose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<ModelCapability>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// A fragment of a tool call. `arguments` is a JSON slice to concatenate by
/// `index` across deltas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallDelta {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
}

/// Worker → server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum WorkerMessage {
    /// First registration; the server replies with a worker id and secret.
    RegisterNew {
        max_concurrent: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    /// Reconnect with stored credentials. A `name` overwrites the stored one.
    RegisterResume {
        worker_id: String,
        secret: String,
        max_concurrent: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Stats {
        /// Models resident on the worker's backends, deduplicated.
        loaded_models: Vec<String>,
        jobs_completed: u64,
        uptime_ms: u64,
    },
    ModelReady {
        job_id: String,
        model: String,
    },
    Delta {
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCallDelta>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
    },
    Embedding {
        job_id: String,
        vector: Vec<f64>,
    },
    Image {
        job_id: String,
        images: Vec<GeneratedImage>,
    },
    /// TTS audio, base64-encoded to fit the JSON protocol.
    Audio {
        job_id: String,
        b64: String,
        mime_type: String,
    },
    Done {
        job_id: String,
        finish_reason: FinishReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
    Error {
        job_id: String,
        message: String,
    },
    /// The worker's models in object form. (The protocol also accepts a
    /// legacy `string[]`, which this worker never sends.)
    Models {
        models: Vec<WorkerModel>,
    },
    Pong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageResponseFormat {
    Url,
    B64Json,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_format: Option<ImageResponseFormat>,
}

/// `response_format` is free-form: backends accept more than OpenAI's set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// Numbers are kept as they arrived so they reach the backend unchanged: an
/// integer `maxTokens` must not become `256.0`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<Number>,
    /// Passed to the backend in OpenAI shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    /// `null` is kept as `Some(Value::Null)`, so it reaches the backend.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts: Option<SpeechOptions>,
}

/// Reads a present field as `Some`, even when it is `null`.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// Server → worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// `secret` is present only in reply to `register_new`.
    Registered {
        worker_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
    },
    Infer {
        job_id: String,
        task: ModelTask,
        model: String,
        input: Value,
        /// Boxed: by far the largest variant.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        options: Option<Box<InferOptions>>,
    },
    /// The consumer went away; abort the job and free its slot.
    Cancel {
        job_id: String,
    },
    Ping,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn worker_messages_match_the_typescript_wire_shape() {
        let cases = [
            (
                WorkerMessage::RegisterResume {
                    worker_id: "w".into(),
                    secret: "s".into(),
                    max_concurrent: 2,
                    name: None,
                },
                json!({ "type": "register_resume", "workerId": "w", "secret": "s", "maxConcurrent": 2 }),
            ),
            (
                WorkerMessage::Delta {
                    job_id: "j".into(),
                    content: None,
                    tool_calls: None,
                    reasoning: Some("hmm".into()),
                },
                json!({ "type": "delta", "jobId": "j", "reasoning": "hmm" }),
            ),
            (
                WorkerMessage::Done {
                    job_id: "j".into(),
                    finish_reason: FinishReason::ToolCalls,
                    usage: Some(Usage { prompt_tokens: 3, completion_tokens: 4 }),
                },
                json!({
                    "type": "done", "jobId": "j", "finishReason": "tool_calls",
                    "usage": { "promptTokens": 3, "completionTokens": 4 }
                }),
            ),
            (
                WorkerMessage::Models {
                    models: vec![WorkerModel {
                        id: "gemma".into(),
                        purpose: Some(ModelPurpose::Chat),
                        capabilities: Some(vec![ModelCapability::Tools]),
                    }],
                },
                json!({ "type": "models", "models": [{ "id": "gemma", "purpose": "chat", "capabilities": ["tools"] }] }),
            ),
            (
                WorkerMessage::Audio {
                    job_id: "j".into(),
                    b64: "AA==".into(),
                    mime_type: "audio/mpeg".into(),
                },
                json!({ "type": "audio", "jobId": "j", "b64": "AA==", "mimeType": "audio/mpeg" }),
            ),
            (WorkerMessage::Pong, json!({ "type": "pong" })),
        ];
        for (message, expected) in cases {
            assert_eq!(serde_json::to_value(&message).unwrap(), expected);
        }
    }

    #[test]
    fn server_messages_decode_from_the_typescript_wire_shape() {
        let infer: ServerMessage = serde_json::from_value(json!({
            "type": "infer", "jobId": "j", "task": "tts", "model": "kokoro", "input": "hi",
            "options": { "maxTokens": 10, "tts": { "voice": "af", "responseFormat": "mp3" } }
        }))
        .unwrap();
        let ServerMessage::Infer { task, options: Some(options), .. } = infer else {
            panic!("expected infer with options");
        };
        assert_eq!(task, ModelTask::Tts);
        assert_eq!(options.max_tokens, Some(10.into()));
        assert_eq!(options.tts.unwrap().response_format.as_deref(), Some("mp3"));

        let registered: ServerMessage =
            serde_json::from_value(json!({ "type": "registered", "workerId": "w" })).unwrap();
        assert_eq!(registered, ServerMessage::Registered { worker_id: "w".into(), secret: None });
        assert_eq!(
            serde_json::from_value::<ServerMessage>(json!({ "type": "ping" })).unwrap(),
            ServerMessage::Ping
        );
    }
}
