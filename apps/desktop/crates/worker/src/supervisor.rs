//! Turns desired state into connections: probes the backends, connects while
//! work is on, reconnects with backoff, and stops when told to.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use shoal_backends::{Backends, Inventory};
use tokio::sync::watch::error::RecvError;
use tokio::sync::{Notify, watch};
use tokio::time::sleep;
use tokio_util::task::AbortOnDropHandle;

use crate::session::{self, End};
use crate::state::{Availability, Connection, Outcome, State};
use crate::{Config, Desired, identity, replace};

const PROBE_INTERVAL: Duration = Duration::from_secs(10);
/// Probing only feeds the window while offline, so it can be slower.
const OFFLINE_PROBE_INTERVAL: Duration = Duration::from_secs(60);
const INITIAL_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);
/// How often a pause re-reads the clock. Timers don't run while the machine
/// sleeps, so one long sleep could overshoot the end of the pause.
const PAUSE_RECHECK: Duration = Duration::from_secs(30);
/// Consecutive "already connected" rejections before giving up. With the
/// backoff that is about a minute: longer than the server takes to evict a
/// dropped connection, so another worker must be using the identity.
const MAX_ALREADY_CONNECTED: u32 = 6;

/// The [`crate::Worker`] was dropped.
pub(crate) struct Stopped;

impl From<RecvError> for Stopped {
    fn from(_: RecvError) -> Self {
        Self
    }
}

pub(crate) type Published = Arc<watch::Sender<State>>;

/// Runs until the [`crate::Worker`] is dropped.
pub(crate) async fn run(
    identity_dir: Option<PathBuf>,
    mut desired: watch::Receiver<Desired>,
    state: watch::Sender<State>,
) {
    let state = Arc::new(state);
    let started = Instant::now();
    loop {
        let config = desired.borrow_and_update().config.clone();
        let served = if let Some(config) = config {
            serve(&config, identity_dir.as_deref(), &mut desired, &state, started).await
        } else {
            state.send_if_modified(|s| {
                replace(&mut s.connection, Connection::Offline)
                    | replace(&mut s.inventory, Inventory::default())
            });
            desired.changed().await.map_err(Stopped::from)
        };
        if served.is_err() {
            return;
        }
    }
}

/// Serves one config until it changes.
async fn serve(
    config: &Config,
    identity_dir: Option<&Path>,
    desired: &mut watch::Receiver<Desired>,
    state: &Published,
    started: Instant,
) -> Result<(), Stopped> {
    let backends = Arc::new(Backends::new(config.backends.iter().cloned()));
    let (inventory_tx, inventory) = watch::channel(None);
    let probe_now = Arc::new(Notify::new());
    let _prober = AbortOnDropHandle::new(tokio::spawn(probe(
        Arc::clone(&backends),
        inventory_tx,
        Arc::clone(&probe_now),
        Arc::clone(state),
    )));

    let loaded = identity::path(identity_dir, &config.server)
        .and_then(|path| identity::load(&path).map(|identity| (path, identity)));
    let (identity_path, mut identity) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => return halt(state, desired, error.to_string()).await,
    };

    let mut retry = INITIAL_RETRY;
    let mut already_connected = 0;
    loop {
        let wanted = desired.borrow_and_update().clone();
        if wanted.config.as_ref() != Some(config) {
            return Ok(());
        }
        let now = SystemTime::now();
        let availability = wanted.availability.at(now);
        state.send_if_modified(|s| replace(&mut s.availability, availability));

        match availability {
            Availability::Off => {
                set_connection(state, Connection::Offline);
                desired.changed().await?;
            }
            Availability::PausedUntil(until) => {
                set_connection(state, Connection::Offline);
                let remaining = until.duration_since(now).unwrap_or_default();
                tokio::select! {
                    changed = desired.changed() => changed?,
                    () = sleep(remaining.min(PAUSE_RECHECK)) => {}
                }
            }
            Availability::On => {
                let context = session::Context {
                    config,
                    identity_path: &identity_path,
                    backends: &backends,
                    inventory: inventory.clone(),
                    probe_now: &probe_now,
                    state,
                    started,
                };
                let end = session::run(context, &mut identity, desired).await;
                state.send_if_modified(|s| {
                    let running: Vec<String> = s.jobs.iter().map(|job| job.id.clone()).collect();
                    running
                        .iter()
                        .fold(false, |ended, id| s.finish(id, Outcome::Abandoned, None) | ended)
                });
                let reason = match end {
                    End::Interrupted => continue,
                    End::Stopped => return Err(Stopped),
                    End::Halted(reason) => return halt(state, desired, reason).await,
                    // Not a fresh start: the backoff keeps growing.
                    End::AlreadyConnected => {
                        already_connected += 1;
                        if already_connected >= MAX_ALREADY_CONNECTED {
                            let reason = "Another worker is connected with this identity, such \
                                          as `shoal worker start`. Stop it, then switch work on.";
                            return halt(state, desired, reason.to_owned()).await;
                        }
                        "this worker is already connected".to_owned()
                    }
                    End::Lost { opened, reason } => {
                        already_connected = 0;
                        if opened {
                            retry = INITIAL_RETRY;
                        }
                        reason
                    }
                };
                tracing::info!("disconnected ({reason}), reconnecting in {retry:?}");
                set_connection(state, Connection::Retrying { reason });
                tokio::select! {
                    changed = desired.changed() => changed?,
                    () = sleep(retry) => {}
                }
                retry = (retry * 2).min(MAX_RETRY);
            }
        }
    }
}

/// Stays halted until anything is changed, then starts over: new settings,
/// or switching work back on, re-reads the identity and retries.
async fn halt(
    state: &Published,
    desired: &mut watch::Receiver<Desired>,
    reason: String,
) -> Result<(), Stopped> {
    tracing::error!("{reason}");
    set_connection(state, Connection::Halted { reason });
    Ok(desired.changed().await?)
}

/// Probes the backends forever, and at once when asked, publishing each
/// result even when unchanged: the session reports every probe.
async fn probe(
    backends: Arc<Backends>,
    inventory: watch::Sender<Option<Arc<Inventory>>>,
    probe_now: Arc<Notify>,
    state: Published,
) {
    loop {
        let found = backends.refresh().await;
        state.send_if_modified(|s| replace(&mut s.inventory, found.clone()));
        inventory.send_replace(Some(Arc::new(found)));
        let online = matches!(state.borrow().connection, Connection::Online { .. });
        tokio::select! {
            () = sleep(if online { PROBE_INTERVAL } else { OFFLINE_PROBE_INTERVAL }) => {}
            () = probe_now.notified() => {}
        }
    }
}

pub(crate) fn set_connection(state: &Published, connection: Connection) {
    state.send_if_modified(|s| replace(&mut s.connection, connection));
}
