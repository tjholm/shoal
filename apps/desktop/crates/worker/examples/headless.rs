//! Runs a worker without a UI, for manual testing. Uses the identity the
//! TypeScript CLI stores, so the two share one worker per server.
//!
//! ```sh
//! SHOAL_SERVER=wss://shoal.example.com/ws/workers SHOAL_TOKEN=... \
//!     cargo run -p shoal-worker --example headless
//! ```
//!
//! Also reads `BACKEND_URL` (comma-separated, default
//! `http://localhost:11434`), `SHOAL_NAME` and `SHOAL_CONCURRENCY`.

use std::env;
use std::num::NonZeroU32;

use shoal_worker::{Availability, Config, State, Token, Worker};
use tracing::Level;

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt().with_max_level(Level::INFO).init();
    let worker = Worker::start(Some(config()?), Availability::On);

    let mut state = worker.subscribe();
    let mut shown = String::new();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            changed = state.changed() => changed.map_err(|e| e.to_string())?,
        }
        let summary = summary(&state.borrow_and_update());
        if summary != shown {
            println!("{summary}");
            shown = summary;
        }
    }
}

fn config() -> Result<Config, String> {
    let var = |name| env::var(name).ok().filter(|value| !value.is_empty());
    let server = var("SHOAL_SERVER").ok_or("set SHOAL_SERVER")?;
    let token = Token::new(var("SHOAL_TOKEN").ok_or("set SHOAL_TOKEN")?);
    let backends: Vec<String> = var("BACKEND_URL")
        .unwrap_or_else(|| "http://localhost:11434".into())
        .split(',')
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(String::from)
        .collect();
    if backends.is_empty() {
        return Err("BACKEND_URL has no URLs".into());
    }
    let max_concurrent = match var("SHOAL_CONCURRENCY") {
        Some(n) => n.parse().map_err(|_| "SHOAL_CONCURRENCY must be a positive integer")?,
        None => NonZeroU32::MIN,
    };
    Ok(Config { server, token, backends, max_concurrent, name: env::var("SHOAL_NAME").ok() })
}

/// One line: the connection, the models on offer and what is running.
fn summary(state: &State) -> String {
    let jobs: Vec<String> = state
        .jobs
        .iter()
        .map(|job| format!("{} {:?} {} ({} chunks)", job.id, job.task, job.model, job.chunks))
        .collect();
    format!(
        "{:?} | {} models, {} loaded | {} done | running: [{}]",
        state.connection,
        state.inventory.models.len(),
        state.inventory.loaded.len(),
        state.jobs_completed,
        jobs.join(", ")
    )
}
