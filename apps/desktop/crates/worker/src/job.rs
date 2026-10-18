use std::sync::Arc;

use serde_json::Value;
use shoal_backends::{Backends, Output};
use shoal_protocol::{InferOptions, ModelTask, WorkerMessage};
use tokio::sync::mpsc::UnboundedSender;

use crate::state::Outcome;
use crate::supervisor::Published;

/// One `infer` request.
#[derive(Debug)]
pub(crate) struct Job {
    pub id: String,
    pub task: ModelTask,
    pub model: String,
    pub input: Value,
    pub options: InferOptions,
}

/// Runs a job to completion, sending its messages to the session. Ends in
/// `done` or `error`; a job that is aborted sends nothing more. Returns the
/// job's id.
pub(crate) async fn run(
    job: Job,
    backends: Arc<Backends>,
    state: Published,
    out: UnboundedSender<WorkerMessage>,
) -> String {
    // Sending fails only once the session has ended, which aborts this job.
    let send = |message| drop(out.send(message));
    send(WorkerMessage::ModelReady { job_id: job.id.clone(), model: job.model.clone() });

    let result = backends
        .infer(job.task, &job.model, &job.input, &job.options, |output| {
            if let Output::Delta { content, reasoning, .. } = &output {
                let thinking = reasoning.is_some() && content.is_none();
                state.send_modify(|s| {
                    if let Some(running) = s.jobs.iter_mut().find(|j| j.id == job.id) {
                        running.chunks += 1;
                        running.thinking = thinking;
                    }
                });
            }
            send(message(&job.id, output));
        })
        .await;

    match result {
        Ok(finish) => {
            let tokens = finish.usage.map(|usage| usage.completion_tokens);
            state.send_modify(|s| {
                s.finish(&job.id, Outcome::Done, tokens);
            });
            send(WorkerMessage::Done {
                job_id: job.id.clone(),
                finish_reason: finish.reason,
                usage: finish.usage,
            });
        }
        Err(error) => {
            tracing::warn!(job = job.id, "inference error: {error}");
            state.send_modify(|s| {
                s.finish(&job.id, Outcome::Failed(error.to_string()), None);
            });
            send(WorkerMessage::Error { job_id: job.id.clone(), message: error.to_string() });
        }
    }
    job.id
}

fn message(job_id: &str, output: Output) -> WorkerMessage {
    let job_id = job_id.to_owned();
    match output {
        Output::Delta { content, tool_calls, reasoning } => {
            WorkerMessage::Delta { job_id, content, tool_calls, reasoning }
        }
        Output::Embedding(vector) => WorkerMessage::Embedding { job_id, vector },
        Output::Images(images) => WorkerMessage::Image { job_id, images },
        Output::Audio { b64, mime_type } => WorkerMessage::Audio { job_id, b64, mime_type },
    }
}
