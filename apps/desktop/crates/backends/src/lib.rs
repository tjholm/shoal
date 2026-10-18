//! Inference backends: model discovery and job proxying for the
//! OpenAI-compatible servers a worker fronts (Ollama, LM Studio, llama.cpp,
//! llama-swap, vLLM and Lemonade).
//!
//! [`Backends`] knows nothing about the worker socket. It reports what the
//! backends serve ([`Inventory`]) and runs a job against whichever backend
//! serves its model, handing results to the caller as [`Output`]s.

mod chat;
mod discovery;
mod error;
mod http;
mod sse;
mod tasks;

use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::Value;
use shoal_protocol::{
    FinishReason, GeneratedImage, InferOptions, ModelTask, ToolCallDelta, Usage, WorkerModel,
};

pub use error::Error;

/// What the backends serve, merged in configured order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inventory {
    /// Deduplicated by id; the first backend to list a model wins.
    pub models: Vec<WorkerModel>,
    /// Ids resident in memory, deduplicated.
    pub loaded: Vec<String>,
    /// Each backend's own findings, in configured order.
    pub backends: Vec<BackendStatus>,
}

/// What one backend reported on the last probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatus {
    pub url: String,
    /// The server it was detected as, e.g. "Ollama"; `None` if unreachable.
    pub kind: Option<&'static str>,
    pub models: Vec<String>,
    pub loaded: Vec<String>,
    /// Why the probe failed.
    pub error: Option<String>,
}

/// A result a job produces before it finishes.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    Delta {
        content: Option<String>,
        tool_calls: Option<Vec<ToolCallDelta>>,
        reasoning: Option<String>,
    },
    Embedding(Vec<f64>),
    Images(Vec<GeneratedImage>),
    Audio {
        b64: String,
        mime_type: String,
    },
}

/// How a job ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Finish {
    pub reason: FinishReason,
    pub usage: Option<Usage>,
}

impl Finish {
    const STOP: Self = Self { reason: FinishReason::Stop, usage: None };
}

/// The configured backends, with the routing table from the last refresh.
#[derive(Debug)]
pub struct Backends {
    http: reqwest::Client,
    backends: Vec<Backend>,
}

#[derive(Debug)]
struct Backend {
    /// Base URL without trailing slashes.
    url: String,
    /// Model ids from the last refresh, in the backend's order.
    models: Mutex<Vec<String>>,
    /// Whether `/props` identifies llama.cpp; probed once.
    is_llamacpp: OnceLock<bool>,
    /// Set once `/api/show` has failed for every model; it is then skipped.
    show_unavailable: AtomicBool,
}

impl Backends {
    /// # Panics
    ///
    /// If the platform TLS backend fails to initialise.
    #[must_use]
    pub fn new(urls: impl IntoIterator<Item = String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("HTTP client");
        let backends = urls
            .into_iter()
            .map(|url| Backend {
                url: url.trim_end_matches('/').to_owned(),
                models: Mutex::default(),
                is_llamacpp: OnceLock::new(),
                show_unavailable: AtomicBool::new(false),
            })
            .collect();
        Self { http, backends }
    }

    /// Probes every backend in parallel, updates the routing table and
    /// returns the merged inventory. A backend that fails contributes nothing
    /// and is unroutable until it recovers.
    pub async fn refresh(&self) -> Inventory {
        let found =
            join_all(self.backends.iter().map(|backend| backend.discover(&self.http))).await;

        let mut inventory = Inventory::default();
        for (backend, found) in self.backends.iter().zip(found) {
            let mut status = BackendStatus {
                url: backend.url.clone(),
                kind: None,
                models: Vec::new(),
                loaded: Vec::new(),
                error: None,
            };
            let found = found.unwrap_or_else(|error| {
                tracing::warn!(backend = backend.url, "failed to fetch models: {error}");
                status.error = Some(error.to_string());
                discovery::Found::default()
            });
            if status.error.is_none() {
                status.kind = Some(found.kind);
                status.models = found.models.iter().map(|m| m.id.clone()).collect();
                status.loaded.clone_from(&found.loaded);
            }
            *lock(&backend.models) = found.models.iter().map(|m| m.id.clone()).collect();
            inventory.backends.push(status);
            for model in found.models {
                if !inventory.models.iter().any(|m| m.id == model.id) {
                    inventory.models.push(model);
                }
            }
            for id in found.loaded {
                if !inventory.loaded.contains(&id) {
                    inventory.loaded.push(id);
                }
            }
        }
        inventory
    }

    /// Runs a job on the first backend serving `model`, passing results to
    /// `emit` as they arrive.
    pub async fn infer(
        &self,
        task: ModelTask,
        model: &str,
        input: &Value,
        options: &InferOptions,
        emit: impl FnMut(Output),
    ) -> Result<Finish, Error> {
        let url = self.resolve(model).await?;
        match task {
            ModelTask::Chat => chat::run(&self.http, url, model, input, options, emit).await,
            ModelTask::Embedding => tasks::embedding(&self.http, url, model, input, emit).await,
            ModelTask::Image => tasks::image(&self.http, url, model, input, options, emit).await,
            ModelTask::Tts => tasks::speech(&self.http, url, model, input, options, emit).await,
        }
    }

    /// Routes by model id alone; the server has already matched the task to
    /// the model's purpose. On a miss the backends are probed once more.
    async fn resolve(&self, model: &str) -> Result<&str, Error> {
        if let Some(url) = self.route(model) {
            return Ok(url);
        }
        self.refresh().await;
        self.route(model).ok_or_else(|| {
            let mut known: Vec<String> = Vec::new();
            for backend in &self.backends {
                for id in lock(&backend.models).iter() {
                    if !known.contains(id) {
                        known.push(id.clone());
                    }
                }
            }
            Error::NoBackendForModel { model: model.to_owned(), known }
        })
    }

    fn route(&self, model: &str) -> Option<&str> {
        self.backends
            .iter()
            .find(|backend| lock(&backend.models).iter().any(|id| id == model))
            .map(|backend| backend.url.as_str())
    }
}

/// The guarded data is always left consistent, so a poisoned lock is safe.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
