use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime};

use shoal_backends::Inventory;
use shoal_protocol::ModelTask;

/// Whether the worker should take work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Availability {
    #[default]
    On,
    Off,
    /// Off until the given time, then on. Wall-clock time, so a pause ends
    /// on schedule even if the machine sleeps through it.
    PausedUntil(SystemTime),
}

impl Availability {
    /// With an elapsed pause read as `On`.
    #[must_use]
    pub fn at(self, now: SystemTime) -> Self {
        match self {
            Self::PausedUntil(until) if until <= now => Self::On,
            other => other,
        }
    }
}

/// The connection to the server.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Connection {
    /// Not connected because work is off, paused or not configured.
    #[default]
    Offline,
    Connecting,
    /// Connected and waiting for the server to accept the registration.
    Registering,
    Online {
        worker_id: String,
    },
    /// Waiting to reconnect after losing the connection.
    Retrying {
        reason: String,
    },
    /// Stopped until the settings change or work is switched back on, e.g.
    /// because the server rejected the token.
    Halted {
        reason: String,
    },
}

/// A job running now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub task: ModelTask,
    pub model: String,
    pub started: Instant,
    /// Streamed chat deltas so far: roughly one token each.
    pub chunks: u64,
    /// Whether the model is reasoning rather than answering.
    pub thinking: bool,
}

/// A job that has ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    pub task: ModelTask,
    pub model: String,
    pub ended: SystemTime,
    pub duration: Duration,
    /// Output tokens: exact when the backend reported usage.
    pub tokens: u64,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Failed(String),
    /// The server cancelled it, e.g. because the client went away.
    Cancelled,
    /// The connection ended, or work was switched off, while it ran.
    Abandoned,
}

/// How many ended jobs [`State::recent`] keeps.
const RECENT: usize = 50;

/// Everything a UI shows about the worker.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct State {
    pub availability: Availability,
    pub connection: Connection,
    /// From the latest probe of the backends; probed while offline too.
    pub inventory: Inventory,
    pub jobs: Vec<Job>,
    /// Jobs that finished successfully since the worker started.
    pub jobs_completed: u64,
    /// Output tokens served since the worker started.
    pub tokens_out: u64,
    /// The latest ended jobs, newest first.
    pub recent: VecDeque<Finished>,
}

impl State {
    /// Moves a running job to [`State::recent`]; `false` if it wasn't running.
    pub(crate) fn finish(&mut self, id: &str, outcome: Outcome, tokens: Option<u64>) -> bool {
        let Some(index) = self.jobs.iter().position(|job| job.id == id) else { return false };
        let job = self.jobs.remove(index);
        let tokens = tokens.unwrap_or(job.chunks);
        if outcome == Outcome::Done {
            self.jobs_completed += 1;
            self.tokens_out += tokens;
        }
        self.recent.push_front(Finished {
            task: job.task,
            model: job.model,
            ended: SystemTime::now(),
            duration: job.started.elapsed(),
            tokens,
            outcome,
        });
        self.recent.truncate(RECENT);
        true
    }
}
