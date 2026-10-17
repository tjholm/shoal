use std::time::{Instant, SystemTime};

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
}
