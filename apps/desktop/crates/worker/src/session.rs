//! One connection to the server, from opening the socket until it closes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use shoal_backends::{Backends, Inventory};
use shoal_protocol::{ServerMessage, WorkerMessage};
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::identity::{self, Identity};
use crate::job::{self, Job};
use crate::state::{self, Connection, Outcome};
use crate::supervisor::{Published, set_connection};
use crate::{Config, Desired};

const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
/// The server closes with this when it rejects the token or identity.
const POLICY_VIOLATION: u16 = 1008;
/// A 1008 for an identity that is already connected: either our previous
/// connection, which the server evicts within about 40 s of it dropping, or
/// another worker sharing the identity.
const ALREADY_CONNECTED: &str = "worker already connected";
/// The server pings every 10 s, so this much silence means the connection
/// is dead even if the OS hasn't noticed, as after the machine sleeps.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(35);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(crate) struct Context<'a> {
    pub config: &'a Config,
    pub identity_path: &'a Path,
    pub backends: &'a Arc<Backends>,
    pub inventory: watch::Receiver<Option<Arc<Inventory>>>,
    /// Asks for a fresh probe, which `inventory` then delivers.
    pub probe_now: &'a Notify,
    pub state: &'a Published,
    pub started: Instant,
}

/// Why a session ended.
#[derive(Debug)]
pub(crate) enum End {
    /// The desired state changed.
    Interrupted,
    /// The worker was dropped.
    Stopped,
    /// Retrying won't help until something changes.
    Halted(String),
    /// The connection failed or dropped; worth retrying.
    Lost { opened: bool, reason: String },
    /// The server already has a connection for this identity.
    AlreadyConnected,
}

/// Connects, registers and serves until the connection ends or the desired
/// state changes. Jobs in flight are aborted when it returns.
pub(crate) async fn run(
    context: Context<'_>,
    identity: &mut Option<Identity>,
    desired: &mut watch::Receiver<Desired>,
) -> End {
    set_connection(context.state, Connection::Connecting);
    tracing::info!("connecting to {}", context.config.server);
    let socket = tokio::select! {
        changed = desired.changed() => return interrupted(&changed),
        result = timeout(OPEN_TIMEOUT, connect_async(context.config.socket_url())) => match result {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => return End::Lost { opened: false, reason: error.to_string() },
            Err(_) => return End::Lost { opened: false, reason: "timed out connecting".into() },
        },
    };
    tracing::info!("connected, registering");
    set_connection(context.state, Connection::Registering);

    let (out, outbox) = mpsc::unbounded_channel();
    let mut session = Session {
        context,
        identity,
        socket,
        out,
        jobs: JoinSet::new(),
        running: HashMap::new(),
        registered: false,
    };
    session.serve(desired, outbox).await.unwrap_or_else(|end| end)
}

fn interrupted(changed: &Result<(), watch::error::RecvError>) -> End {
    if changed.is_ok() { End::Interrupted } else { End::Stopped }
}

struct Session<'a, 'c> {
    context: Context<'c>,
    identity: &'a mut Option<Identity>,
    socket: Socket,
    /// Where jobs send their messages for the socket.
    out: mpsc::UnboundedSender<WorkerMessage>,
    jobs: JoinSet<String>,
    running: HashMap<String, AbortHandle>,
    registered: bool,
}

impl Session<'_, '_> {
    /// Returns `Ok` when the desired state changes, after closing the socket
    /// cleanly.
    async fn serve(
        &mut self,
        desired: &mut watch::Receiver<Desired>,
        mut outbox: mpsc::UnboundedReceiver<WorkerMessage>,
    ) -> Result<End, End> {
        let register = match &*self.identity {
            None => WorkerMessage::RegisterNew {
                max_concurrent: self.context.config.max_concurrent.get(),
                name: self.context.config.name.clone(),
            },
            Some(identity) => WorkerMessage::RegisterResume {
                worker_id: identity.worker_id.clone(),
                secret: identity.secret.clone(),
                max_concurrent: self.context.config.max_concurrent.get(),
                name: self.context.config.name.clone(),
            },
        };
        self.send(&register).await?;

        let mut probing = true;
        let silence = tokio::time::sleep(SILENCE_TIMEOUT);
        tokio::pin!(silence);
        loop {
            tokio::select! {
                changed = desired.changed() => {
                    let close = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                    let _ = timeout(CLOSE_TIMEOUT, self.socket.close(Some(close))).await;
                    return Ok(interrupted(&changed));
                }
                () = &mut silence => return Err(lost("the server stopped responding".into())),
                frame = self.socket.next() => {
                    silence.as_mut().reset(tokio::time::Instant::now() + SILENCE_TIMEOUT);
                    match frame {
                    Some(Ok(Message::Text(text))) => self.receive(&text).await?,
                    Some(Ok(Message::Binary(bytes))) => {
                        self.receive(&String::from_utf8_lossy(&bytes)).await?;
                    }
                    Some(Ok(Message::Close(frame))) => return Err(closed(frame, self.context.identity_path)),
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(lost(error.to_string())),
                    None => return Err(lost("connection closed".into())),
                    }
                }
                Some(message) = outbox.recv() => self.send_queued(message, &mut outbox).await?,
                changed = self.context.inventory.changed(), if self.registered && probing => match changed {
                    Ok(()) => {
                        let found = self.context.inventory.borrow_and_update().clone();
                        if let Some(found) = found {
                            self.report(&found).await?;
                        }
                    }
                    Err(_) => probing = false,
                },
                Some(finished) = self.jobs.join_next_with_id() => self.finished(finished).await?,
            }
        }
    }

    async fn receive(&mut self, text: &str) -> Result<(), End> {
        let message = match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => message,
            Err(error) => return self.invalid(text, &error).await,
        };
        match message {
            ServerMessage::Registered { worker_id, secret } => {
                self.registered(worker_id, secret)?;
            }
            ServerMessage::Ping => self.send(&WorkerMessage::Pong).await?,
            ServerMessage::Infer { job_id, task, model, input, options } => {
                let options = options.map(|options| *options).unwrap_or_default();
                self.start(Job { id: job_id, task, model, input, options });
            }
            ServerMessage::Cancel { job_id } => {
                if let Some(job) = self.running.remove(&job_id) {
                    tracing::info!("cancel received for job {job_id}");
                    job.abort();
                    self.end(&job_id, Outcome::Cancelled);
                }
            }
        }
        Ok(())
    }

    fn registered(&mut self, worker_id: String, secret: Option<String>) -> Result<(), End> {
        if let Some(secret) = secret {
            let issued = Identity { worker_id: worker_id.clone(), secret };
            let saved = identity::save(self.context.identity_path, &issued);
            *self.identity = Some(issued);
            saved.map_err(|error| End::Halted(error.to_string()))?;
            tracing::info!("registered (new) as {worker_id}, identity saved");
        } else {
            tracing::info!("registered (resumed) as {worker_id}");
        }
        self.registered = true;
        set_connection(self.context.state, Connection::Online { worker_id });

        // Report a fresh probe, not whatever was probed before connecting.
        self.context.inventory.borrow_and_update();
        self.context.probe_now.notify_one();
        Ok(())
    }

    /// Unreadable messages are ignored, but an unreadable job is answered
    /// with an error so the server doesn't wait on it forever.
    async fn invalid(&mut self, text: &str, error: &serde_json::Error) -> Result<(), End> {
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(rename = "type")]
            kind: String,
            #[serde(rename = "jobId")]
            job_id: Option<String>,
        }
        tracing::warn!("invalid message from server: {error}");
        if self.registered
            && let Ok(Envelope { kind, job_id: Some(job_id) }) = serde_json::from_str(text)
            && kind == "infer"
        {
            let message = format!("Invalid job: {error}");
            self.send(&WorkerMessage::Error { job_id, message }).await?;
        }
        Ok(())
    }

    fn start(&mut self, job: Job) {
        let id = job.id.clone();
        self.context.state.send_modify(|s| {
            s.jobs.retain(|running| running.id != id);
            s.jobs.push(state::Job {
                id: id.clone(),
                task: job.task,
                model: job.model.clone(),
                started: Instant::now(),
                chunks: 0,
                thinking: false,
            });
        });
        let run = job::run(
            job,
            Arc::clone(self.context.backends),
            Arc::clone(self.context.state),
            self.out.clone(),
        );
        if let Some(replaced) = self.running.insert(id, self.jobs.spawn(run)) {
            replaced.abort();
        }
    }

    async fn finished(
        &mut self,
        finished: Result<(tokio::task::Id, String), tokio::task::JoinError>,
    ) -> Result<(), End> {
        match finished {
            // The job recorded how it ended.
            Ok((_, job_id)) => {
                self.running.remove(&job_id);
            }
            // Recorded when cancelled.
            Err(error) if error.is_cancelled() => {}
            Err(error) => {
                let task = error.id();
                let job_id =
                    self.running.iter().find(|(_, job)| job.id() == task).map(|(id, _)| id.clone());
                if let Some(job_id) = job_id {
                    tracing::error!(job = job_id, "job panicked: {error}");
                    self.running.remove(&job_id);
                    let message = "The worker failed while running this job.".to_owned();
                    self.end(&job_id, Outcome::Failed(message.clone()));
                    self.send(&WorkerMessage::Error { job_id, message }).await?;
                }
            }
        }
        Ok(())
    }

    fn end(&self, job_id: &str, outcome: Outcome) {
        self.context.state.send_if_modified(|s| s.finish(job_id, outcome, None));
    }

    /// `models` then `stats`, as the server expects after every probe.
    async fn report(&mut self, found: &Inventory) -> Result<(), End> {
        self.send(&WorkerMessage::Models { models: found.models.clone() }).await?;
        let jobs_completed = self.context.state.borrow().jobs_completed;
        let uptime_ms =
            u64::try_from(self.context.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.send(&WorkerMessage::Stats {
            loaded_models: found.loaded.clone(),
            jobs_completed,
            uptime_ms,
        })
        .await
    }

    async fn send(&mut self, message: &WorkerMessage) -> Result<(), End> {
        self.socket.send(text(message)).await.map_err(|error| lost(error.to_string()))
    }

    /// Sends `first` and whatever else jobs have queued, flushing once.
    async fn send_queued(
        &mut self,
        first: WorkerMessage,
        outbox: &mut mpsc::UnboundedReceiver<WorkerMessage>,
    ) -> Result<(), End> {
        let mut message = Some(first);
        while let Some(next) = message {
            self.socket.feed(text(&next)).await.map_err(|error| lost(error.to_string()))?;
            message = outbox.try_recv().ok();
        }
        self.socket.flush().await.map_err(|error| lost(error.to_string()))
    }
}

fn text(message: &WorkerMessage) -> Message {
    Message::text(serde_json::to_string(message).expect("worker messages always serialize"))
}

fn lost(reason: String) -> End {
    End::Lost { opened: true, reason }
}

/// A close from the server. Only a credential rejection is final.
fn closed(frame: Option<CloseFrame>, identity_path: &Path) -> End {
    let (code, reason) =
        frame.map_or((1005, String::new()), |f| (f.code.into(), f.reason.to_string()));
    if code == POLICY_VIOLATION && reason == ALREADY_CONNECTED {
        return End::AlreadyConnected;
    }
    if code != POLICY_VIOLATION {
        return lost(if reason.is_empty() { code.to_string() } else { format!("{code} {reason}") });
    }
    End::Halted(match reason.as_str() {
        "invalid api key" => "The server rejected the token.".to_owned(),
        "invalid worker credentials" => format!(
            "The server doesn't recognise this worker's identity. If its database was reset, \
             delete {} to register as a new worker.",
            identity_path.display()
        ),
        _ => format!("The server refused the connection ({code} {reason})."),
    })
}
