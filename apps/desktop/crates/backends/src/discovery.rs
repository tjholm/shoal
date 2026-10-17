//! Works out which server a backend is from its `/v1/models` listing, then
//! normalises its models and asks it which are loaded.

use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{StreamExt, stream};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Map, Value};
use shoal_protocol::{ModelCapability, ModelPurpose, WorkerModel};

use crate::http::{execute, json};
use crate::{Backend, Error};

/// Discovery runs every 10 s; a backend that stops answering must not
/// stall it.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const OLLAMA_SHOW_CONCURRENCY: usize = 4;

#[derive(Debug, Default)]
pub(crate) struct Found {
    pub models: Vec<WorkerModel>,
    pub loaded: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Lemonade,
    LmStudio,
    Vllm,
    LlamaSwap,
    LlamaCpp,
    /// Also any other OpenAI-compatible server.
    Ollama,
}

#[derive(Debug, Deserialize)]
struct ModelList {
    data: Vec<RawModel>,
}

/// The `/v1/models` fields the dialects are told apart by.
#[derive(Debug, Deserialize)]
struct RawModel {
    id: String,
    owned_by: Option<String>,
    // Lemonade
    recipe: Option<String>,
    labels: Option<Vec<String>>,
    max_context_window: Option<f64>,
    // LM Studio
    #[serde(rename = "type")]
    kind: Option<String>,
    arch: Option<String>,
    state: Option<String>,
    // vLLM
    permission: Option<Vec<Value>>,
    max_model_len: Option<f64>,
}

impl Backend {
    pub(crate) async fn discover(&self, client: &Client) -> Result<Found, Error> {
        let list: ModelList = self.get(client, "/v1/models").await?;
        let dialect = self.dialect(client, &list.data).await;
        let models = match dialect {
            Dialect::Lemonade => list.data.iter().map(lemonade_model).collect(),
            Dialect::LmStudio => list.data.iter().map(lmstudio_model).collect(),
            Dialect::Vllm | Dialect::LlamaSwap => list.data.iter().map(|m| bare(&m.id)).collect(),
            Dialect::LlamaCpp => list
                .data
                .iter()
                .map(|m| WorkerModel { purpose: Some(ModelPurpose::Chat), ..bare(&m.id) })
                .collect(),
            Dialect::Ollama => self.ollama_models(client, &list.data).await,
        };
        let loaded = self.loaded(client, dialect, &list.data).await.unwrap_or_else(|error| {
            tracing::warn!(backend = self.url, ?dialect, "failed to fetch loaded models: {error}");
            Vec::new()
        });
        Ok(Found { models, loaded })
    }

    /// The first dialect any listed model matches, checked in a fixed order.
    async fn dialect(&self, client: &Client, models: &[RawModel]) -> Dialect {
        let any = |test: fn(&RawModel) -> bool| models.iter().any(test);
        if any(|m| m.labels.is_some() || m.max_context_window.is_some()) {
            Dialect::Lemonade
        } else if any(|m| {
            [m.kind.is_some(), m.arch.is_some(), m.state.is_some()]
                .into_iter()
                .filter(|&b| b)
                .count()
                >= 2
        }) {
            Dialect::LmStudio
        } else if any(|m| {
            m.owned_by.as_deref() == Some("vllm")
                || (m.permission.is_some() && m.max_model_len.is_some())
        }) {
            Dialect::Vllm
        } else if any(|m| m.owned_by.as_deref() == Some("llama-swap")) {
            Dialect::LlamaSwap
        } else if self.is_llamacpp(client).await {
            Dialect::LlamaCpp
        } else {
            Dialect::Ollama
        }
    }

    /// llama.cpp's `/props` has keys no other server uses. Probed once per
    /// backend; any failure means "not llama.cpp".
    async fn is_llamacpp(&self, client: &Client) -> bool {
        if let Some(&known) = self.is_llamacpp.get() {
            return known;
        }
        let found = self.get::<Map<String, Value>>(client, "/props").await.is_ok_and(|props| {
            ["chat_template", "default_generation_settings", "total_slots"]
                .iter()
                .any(|key| props.contains_key(*key))
        });
        *self.is_llamacpp.get_or_init(|| found)
    }

    /// Asks `/api/show` for each model's capabilities. If no model answers,
    /// the backend isn't Ollama and is never asked again.
    async fn ollama_models(&self, client: &Client, models: &[RawModel]) -> Vec<WorkerModel> {
        if models.is_empty() || self.show_unavailable.load(Ordering::Relaxed) {
            return models.iter().map(|m| bare(&m.id)).collect();
        }
        // Collected first: a lazy `map` would put a closure in this future's
        // type and stop it being `Send` (rust-lang/rust#64552).
        let probes: Vec<_> = models.iter().map(|model| self.show(client, &model.id)).collect();
        let shown: Vec<Option<OllamaShow>> =
            stream::iter(probes).buffered(OLLAMA_SHOW_CONCURRENCY).collect().await;
        if shown.iter().all(Option::is_none) && !self.show_unavailable.swap(true, Ordering::Relaxed)
        {
            tracing::info!(
                backend = self.url,
                "backend did not respond to /api/show; model capabilities will be reported as \
                 unknown and the server will route to it permissively"
            );
        }
        models
            .iter()
            .zip(shown)
            .map(|(model, show)| match show {
                Some(show) => ollama_model(&model.id, &show.capabilities),
                None => bare(&model.id),
            })
            .collect()
    }

    /// `None` on any failure.
    async fn show(&self, client: &Client, id: &str) -> Option<OllamaShow> {
        let request = client
            .post(format!("{}/api/show", self.url))
            .json(&serde_json::json!({ "name": id }))
            .timeout(PROBE_TIMEOUT);
        json(execute(client, request).await.ok()?).await.ok()
    }

    /// The ids resident in memory, by whatever means the dialect offers.
    /// Servers that can't tell count every model as loaded.
    async fn loaded(
        &self,
        client: &Client,
        dialect: Dialect,
        models: &[RawModel],
    ) -> Result<Vec<String>, Error> {
        Ok(match dialect {
            Dialect::Ollama => {
                let ps: OllamaPs = self.get(client, "/api/ps").await?;
                ps.models.into_iter().filter_map(|m| m.model.or(m.name)).collect()
            }
            Dialect::LmStudio => models
                .iter()
                .filter(|m| m.state.as_deref() == Some("loaded"))
                .map(|m| m.id.clone())
                .collect(),
            Dialect::LlamaSwap => {
                let running: LlamaSwapRunning = self.get(client, "/running").await?;
                running
                    .running
                    .into_iter()
                    .filter(|r| r.state == "ready")
                    .map(|r| r.model)
                    .collect()
            }
            Dialect::Lemonade => {
                let health: LemonadeHealth = self.get(client, "/api/v1/health").await?;
                health.all_models_loaded.into_iter().filter_map(|m| m.model_name).collect()
            }
            Dialect::Vllm | Dialect::LlamaCpp => models.iter().map(|m| m.id.clone()).collect(),
        })
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        client: &Client,
        path: &str,
    ) -> Result<T, Error> {
        let request = client.get(format!("{}{path}", self.url)).timeout(PROBE_TIMEOUT);
        json(execute(client, request).await?).await
    }
}

#[derive(Debug, Deserialize)]
struct OllamaShow {
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaPs {
    #[serde(default)]
    models: Vec<OllamaPsModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaPsModel {
    model: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LlamaSwapRunning {
    running: Vec<LlamaSwapModel>,
}

#[derive(Debug, Deserialize)]
struct LlamaSwapModel {
    model: String,
    state: String,
}

#[derive(Debug, Deserialize)]
struct LemonadeHealth {
    #[serde(default)]
    all_models_loaded: Vec<LemonadeLoaded>,
}

#[derive(Debug, Deserialize)]
struct LemonadeLoaded {
    model_name: Option<String>,
}

fn bare(id: &str) -> WorkerModel {
    WorkerModel { id: id.to_owned(), purpose: None, capabilities: None }
}

/// Capabilities in the protocol's fixed order, given the server's name for
/// each; `None` when there are none.
fn capabilities(names: [&str; 3], has: impl Fn(&str) -> bool) -> Option<Vec<ModelCapability>> {
    let all = [ModelCapability::Tools, ModelCapability::Vision, ModelCapability::Thinking];
    let found: Vec<_> =
        all.into_iter().zip(names).filter(|(_, name)| has(name)).map(|(c, _)| c).collect();
    (!found.is_empty()).then_some(found)
}

fn ollama_model(id: &str, caps: &[String]) -> WorkerModel {
    let has = |name: &str| caps.iter().any(|c| c == name);
    let purpose = if has("completion") {
        Some(ModelPurpose::Chat)
    } else if has("embedding") {
        Some(ModelPurpose::Embedding)
    } else {
        None
    };
    WorkerModel {
        id: id.to_owned(),
        purpose,
        capabilities: capabilities(["tools", "vision", "thinking"], has),
    }
}

fn lemonade_model(model: &RawModel) -> WorkerModel {
    let purpose = model.recipe.as_deref().and_then(|recipe| match recipe {
        "sd-cpp" => Some(ModelPurpose::Image),
        "kokoro" => Some(ModelPurpose::Tts),
        "flm" | "llamacpp" | "ryzenai" => Some(ModelPurpose::Chat),
        unknown => {
            tracing::debug!(recipe = unknown, "unknown Lemonade recipe; purpose left unset");
            None
        }
    });
    let labels = model.labels.as_deref().unwrap_or_default();
    WorkerModel {
        id: model.id.clone(),
        purpose,
        capabilities: capabilities(["tool-calling", "vision", "reasoning"], |name| {
            labels.iter().any(|label| label == name)
        }),
    }
}

fn lmstudio_model(model: &RawModel) -> WorkerModel {
    let (purpose, capabilities) = match model.kind.as_deref() {
        Some("llm") => (Some(ModelPurpose::Chat), None),
        Some("vlm") => (Some(ModelPurpose::Chat), Some(vec![ModelCapability::Vision])),
        Some("embeddings") => (Some(ModelPurpose::Embedding), None),
        _ => (None, None),
    };
    WorkerModel { id: model.id.clone(), purpose, capabilities }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(value: &Value) -> Vec<RawModel> {
        serde_json::from_value::<ModelList>(json!({ "data": value })).unwrap().data
    }

    /// Dialects that never need `/props`, so no server is required.
    async fn listed_dialect(models: Value) -> Dialect {
        let backend = crate::Backends::new(["http://127.0.0.1:9".to_owned()]);
        backend.backends[0].is_llamacpp.set(false).unwrap();
        backend.backends[0].dialect(&backend.http, &raw(&models)).await
    }

    #[tokio::test]
    async fn dialects_are_detected_from_any_model_in_a_fixed_order() {
        let cases = [
            (
                json!([{ "id": "a" }, { "id": "b", "labels": [], "owned_by": "vllm" }]),
                Dialect::Lemonade,
            ),
            (json!([{ "id": "a", "type": "llm", "state": "loaded" }]), Dialect::LmStudio),
            (json!([{ "id": "a", "type": "llm" }]), Dialect::Ollama),
            (json!([{ "id": "a", "permission": [], "max_model_len": 4096 }]), Dialect::Vllm),
            (json!([{ "id": "a", "owned_by": "llama-swap" }]), Dialect::LlamaSwap),
            (json!([]), Dialect::Ollama),
        ];
        for (models, expected) in cases {
            assert_eq!(listed_dialect(models.clone()).await, expected, "{models}");
        }
    }

    #[test]
    fn models_are_normalised_per_dialect() {
        let lemonade = raw(&json!([
            { "id": "q", "recipe": "llamacpp", "labels": ["reasoning", "tool-calling"] },
            { "id": "s", "recipe": "sd-cpp", "labels": [] },
            { "id": "x", "recipe": "mystery" },
        ]));
        assert_eq!(
            lemonade.iter().map(lemonade_model).collect::<Vec<_>>(),
            [
                WorkerModel {
                    id: "q".into(),
                    purpose: Some(ModelPurpose::Chat),
                    capabilities: Some(vec![ModelCapability::Tools, ModelCapability::Thinking]),
                },
                WorkerModel {
                    id: "s".into(),
                    purpose: Some(ModelPurpose::Image),
                    capabilities: None
                },
                bare("x"),
            ]
        );

        let caps = |list: &[&str]| list.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            ollama_model("g", &caps(&["thinking", "completion", "vision"])),
            WorkerModel {
                id: "g".into(),
                purpose: Some(ModelPurpose::Chat),
                capabilities: Some(vec![ModelCapability::Vision, ModelCapability::Thinking]),
            }
        );
        assert_eq!(
            ollama_model("e", &caps(&["embedding"])),
            WorkerModel {
                id: "e".into(),
                purpose: Some(ModelPurpose::Embedding),
                capabilities: None
            }
        );

        let lmstudio = raw(&json!([{ "id": "v", "type": "vlm" }, { "id": "o", "type": "other" }]));
        assert_eq!(
            lmstudio.iter().map(lmstudio_model).collect::<Vec<_>>(),
            [
                WorkerModel {
                    id: "v".into(),
                    purpose: Some(ModelPurpose::Chat),
                    capabilities: Some(vec![ModelCapability::Vision]),
                },
                bare("o"),
            ]
        );
    }
}
