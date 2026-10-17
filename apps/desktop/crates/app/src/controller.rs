//! The app's model: owns the worker and its settings, mirrors the worker's
//! state into GPUI, and turns it into the status the tray and window show.

use std::num::NonZeroU32;
use std::time::{Duration, SystemTime};

use gpui::{Context, Task};
use shoal_worker::{Availability, Connection, State, Token, Worker};

use crate::settings::Settings;
use crate::{keychain, login};

/// The fastest the UI follows the worker; streaming jobs change it far more
/// often than is worth drawing.
const UI_REFRESH: Duration = Duration::from_millis(100);

pub struct Controller {
    // Declared before the runtime it runs on, so it is dropped first.
    worker: Worker,
    _runtime: tokio::runtime::Runtime,
    settings: Settings,
    token: Option<Token>,
    /// The keychain is slow to read, so the token arrives after startup.
    token_loaded: bool,
    launch_at_login: bool,
    state: State,
}

/// Settings as edited in the window.
#[derive(Debug)]
pub struct Edit {
    pub server: String,
    /// A newly entered token; `None` keeps the saved one.
    pub token: Option<Token>,
    pub name: String,
    pub backends: Vec<String>,
    pub concurrency: NonZeroU32,
    pub launch_at_login: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Good,
    Busy,
    Idle,
    Problem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub label: String,
    pub detail: Option<String>,
    pub tone: Tone,
}

impl Controller {
    /// # Panics
    ///
    /// If the Tokio runtime can't start.
    pub fn new(cx: &mut Context<Self>) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("shoal-worker")
            .enable_all()
            .build()
            .expect("Tokio runtime");
        let settings = Settings::load();
        let worker = {
            let _runtime = runtime.enter();
            Worker::start(None, settings.availability.into())
        };

        // Worker state arrives on the runtime; hop it over to the UI thread,
        // at most once per UI_REFRESH.
        let mut changes = worker.subscribe();
        let state = changes.borrow().clone();
        let (to_ui, from_worker) = async_channel::bounded(1);
        runtime.spawn(async move {
            while changes.changed().await.is_ok() {
                let state = changes.borrow_and_update().clone();
                if to_ui.send(state).await.is_err() {
                    break;
                }
                tokio::time::sleep(UI_REFRESH).await;
            }
        });
        cx.spawn(async move |this, cx| {
            while let Ok(state) = from_worker.recv().await {
                let updated = this.update(cx, |this, cx| {
                    this.state = state;
                    cx.notify();
                });
                if updated.is_err() {
                    break;
                }
            }
        })
        .detach();

        // The keychain may ask the user for access, so it's read off the UI
        // thread; the worker starts once it has the token.
        let server = settings.server.clone();
        cx.spawn(async move |this, cx| {
            let token = cx
                .background_executor()
                .spawn(async move {
                    if server.is_empty() { Ok(None) } else { keychain::token(&server) }
                })
                .await
                .unwrap_or_else(|error| {
                    tracing::error!("couldn't read the token from the keychain: {error}");
                    None
                });
            let _ = this.update(cx, |this, cx| {
                this.token = token.map(Token::new);
                this.token_loaded = true;
                this.reconfigure();
                cx.notify();
            });
        })
        .detach();

        Self {
            worker,
            _runtime: runtime,
            settings,
            token: None,
            token_loaded: false,
            launch_at_login: login::is_enabled(),
            state,
        }
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    pub fn launch_at_login(&self) -> bool {
        self.launch_at_login
    }

    /// What the user asked for, which the worker may not have caught up with.
    fn availability(&self) -> Availability {
        Availability::from(self.settings.availability).at(SystemTime::now())
    }

    pub fn accepting(&self) -> bool {
        self.availability() == Availability::On
    }

    /// Switching off or pausing disconnects at once, abandoning running jobs.
    pub fn set_availability(&mut self, availability: Availability, cx: &mut Context<Self>) {
        self.worker.set_availability(availability);
        self.settings.availability = availability.into();
        self.save_settings();
        cx.notify();
    }

    /// Saves the settings and token, then reconnects with them. The keychain
    /// and login item are updated off the UI thread.
    pub fn apply(&mut self, edit: Edit, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let current_server = self.settings.server.clone();
        let current_token = self.token.clone();
        let change_login =
            (edit.launch_at_login != self.launch_at_login).then_some(edit.launch_at_login);
        let Edit { server, token, name, backends, concurrency, launch_at_login } = edit;
        cx.spawn(async move |this, cx| {
            let (server, token) = cx
                .background_executor()
                .spawn(async move {
                    let token = match token {
                        Some(token) => {
                            keychain::save_token(&server, token.expose()).map_err(|error| {
                                format!("Couldn't save the token to the keychain: {error}")
                            })?;
                            Some(token)
                        }
                        None if server == current_server => current_token,
                        None => keychain::token(&server)
                            .map_err(|error| {
                                format!("Couldn't read the token from the keychain: {error}")
                            })?
                            .map(Token::new),
                    };
                    if let Some(enabled) = change_login {
                        login::set_enabled(enabled)?;
                    }
                    Ok::<_, String>((server, token))
                })
                .await?;
            this.update(cx, |this, cx| {
                this.settings = Settings {
                    server,
                    name,
                    backends,
                    concurrency,
                    availability: this.settings.availability,
                };
                this.save_settings();
                this.token = token;
                this.token_loaded = true;
                this.launch_at_login = launch_at_login;
                this.reconfigure();
                cx.notify();
            })
            .map_err(|_| "The app is closing.".to_owned())
        })
    }

    fn reconfigure(&self) {
        self.worker.configure(self.settings.config(self.token.as_ref().map(Token::expose)));
    }

    /// A small local file, so written in place; failures are only logged.
    fn save_settings(&self) {
        if let Err(error) = self.settings.save() {
            tracing::error!("couldn't save settings: {error}");
        }
    }

    pub fn status(&self) -> Status {
        let status = |label: &str, tone, detail: Option<&str>| Status {
            label: label.to_owned(),
            detail: detail.map(ToOwned::to_owned),
            tone,
        };
        if !self.token_loaded {
            return status("Starting…", Tone::Busy, None);
        }
        let configured = self.settings.config(self.token.as_ref().map(Token::expose)).is_some();
        match self.availability() {
            Availability::Off => status("Not accepting work", Tone::Idle, None),
            Availability::PausedUntil(until) => status(
                &format!("Paused until {}", crate::ui::format::clock(until)),
                Tone::Idle,
                None,
            ),
            Availability::On if !configured => {
                status("Not set up", Tone::Problem, Some("Add the server and token in Settings."))
            }
            Availability::On => match &self.state.connection {
                Connection::Offline | Connection::Connecting => {
                    status("Connecting…", Tone::Busy, None)
                }
                Connection::Registering => status("Registering…", Tone::Busy, None),
                Connection::Online { .. } => match self.state.jobs.len() {
                    0 => status("Online", Tone::Good, None),
                    1 => status("Online · 1 job", Tone::Good, None),
                    n => status(&format!("Online · {n} jobs"), Tone::Good, None),
                },
                Connection::Retrying { reason } => {
                    status("Reconnecting…", Tone::Busy, Some(reason))
                }
                Connection::Halted { reason } => status("Stopped", Tone::Problem, Some(reason)),
            },
        }
    }
}
