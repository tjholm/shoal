//! A shoal worker: connects to a shoal server, advertises the models its
//! backends serve and runs the jobs it is sent. Wire-compatible with the
//! TypeScript worker (`shoal worker start`), and shares its stored identity.
//!
//! [`Worker`] is driven by desired state, the [`Config`] and whether to take
//! work ([`Availability`]), and publishes everything a UI needs as [`State`].
//! It has no UI dependencies and runs on the caller's Tokio runtime.

mod config;
mod identity;
mod job;
mod session;
mod state;
mod supervisor;

use std::path::PathBuf;

use tokio::sync::watch;
use tokio_util::task::AbortOnDropHandle;

pub use config::{Config, Token};
pub use shoal_backends::Inventory;
pub use shoal_protocol::{ModelCapability, ModelPurpose, ModelTask, WorkerModel};
pub use state::{Availability, Connection, Job, State};

/// What the worker should be doing.
#[derive(Debug, Clone, Default, PartialEq)]
struct Desired {
    config: Option<Config>,
    availability: Availability,
}

/// A running worker. Dropping it disconnects immediately, abandoning any
/// jobs in flight.
#[derive(Debug)]
pub struct Worker {
    // Declared first so it is dropped first: the supervisor stops before it
    // can see the channels close.
    _supervisor: AbortOnDropHandle<()>,
    desired: watch::Sender<Desired>,
    state: watch::Receiver<State>,
}

impl Worker {
    /// Starts the worker; with no config it waits for one. Identities are
    /// shared with the TypeScript CLI.
    ///
    /// # Panics
    ///
    /// If called outside a Tokio runtime.
    #[must_use]
    pub fn start(config: Option<Config>, availability: Availability) -> Self {
        Self::spawn(identity::default_dir(), config, availability)
    }

    /// Like [`Worker::start`], but keeps identities in `dir`.
    ///
    /// # Panics
    ///
    /// If called outside a Tokio runtime.
    #[must_use]
    pub fn start_with_identity_dir(
        dir: PathBuf,
        config: Option<Config>,
        availability: Availability,
    ) -> Self {
        Self::spawn(Some(dir), config, availability)
    }

    fn spawn(
        identity_dir: Option<PathBuf>,
        config: Option<Config>,
        availability: Availability,
    ) -> Self {
        let (desired, desired_rx) = watch::channel(Desired { config, availability });
        let (state_tx, state) = watch::channel(State { availability, ..State::default() });
        let supervisor = tokio::spawn(supervisor::run(identity_dir, desired_rx, state_tx));
        Self { _supervisor: AbortOnDropHandle::new(supervisor), desired, state }
    }

    /// Applies new settings, reconnecting if they differ.
    pub fn configure(&self, config: Option<Config>) {
        self.desired.send_if_modified(|desired| replace(&mut desired.config, config));
    }

    /// Switching off or pausing disconnects at once and abandons running jobs.
    pub fn set_availability(&self, availability: Availability) {
        self.desired.send_if_modified(|desired| replace(&mut desired.availability, availability));
    }

    /// The worker's state, updated as it changes.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<State> {
        self.state.clone()
    }
}

/// Sets `slot` to `value`, returning whether that changed it.
fn replace<T: PartialEq>(slot: &mut T, value: T) -> bool {
    let changed = *slot != value;
    if changed {
        *slot = value;
    }
    changed
}
