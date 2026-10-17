//! The main window: status and availability, running jobs, detected models
//! and settings.

use std::num::NonZeroU32;
use std::time::{Duration, Instant, SystemTime};

use gpui::{
    AnyElement, App, Bounds, Context, Div, Entity, Focusable, FontWeight, Hsla, KeyBinding,
    SharedString, Stateful, Subscription, Task, Window, WindowBounds, WindowHandle, WindowOptions,
    actions, div, prelude::*, px, size,
};
use shoal_worker::{Availability, ModelTask, Token, WorkerModel};

use super::format;
use super::text_field::TextField;
use super::theme::Theme;
use crate::controller::{Controller, Edit};

actions!(main_window, [Save, FocusNext, FocusPrevious, Close]);

const PAUSES: [(&str, u64); 5] = [("10m", 10), ("30m", 30), ("1h", 60), ("3h", 180), ("8h", 480)];

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", Save, Some("TextField")),
        KeyBinding::new("tab", FocusNext, None),
        KeyBinding::new("shift-tab", FocusPrevious, None),
        KeyBinding::new("secondary-w", Close, None),
    ]);
}

pub fn open(controller: Entity<Controller>, cx: &mut App) -> Option<WindowHandle<MainWindow>> {
    let bounds = Bounds::centered(None, size(px(560.), px(760.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(440.), px(420.))),
        app_id: Some("io.shoal.desktop".to_owned()),
        ..WindowOptions::default()
    };
    cx.open_window(options, |window, cx| {
        window.set_window_title("Shoal");
        cx.new(|cx| MainWindow::new(controller, window, cx))
    })
    .inspect_err(|error| tracing::error!("couldn't open the window: {error}"))
    .ok()
}

pub struct MainWindow {
    controller: Entity<Controller>,
    server: Entity<TextField>,
    token: Entity<TextField>,
    name: Entity<TextField>,
    backends: Entity<TextField>,
    concurrency: Entity<TextField>,
    launch_at_login: bool,
    /// Whether the token field's placeholder says a token is saved.
    shows_saved_token: Option<bool>,
    saving: bool,
    /// The outcome of the last save: `Ok` with a note, or the error.
    saved: Option<Result<SharedString, SharedString>>,
    _subscriptions: [Subscription; 2],
    _ticker: Task<()>,
}

impl MainWindow {
    fn new(controller: Entity<Controller>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (settings, launch_at_login) = {
            let controller = controller.read(cx);
            (controller.settings().clone(), controller.launch_at_login())
        };
        let field = |text: &str, placeholder: &'static str, cx: &mut Context<Self>| {
            cx.new(|cx| TextField::new(text, placeholder, cx))
        };
        let server = field(&settings.server, "wss://shoal.example.com/ws/workers", cx);
        let token = cx.new(|cx| TextField::new("", "", cx).masked());
        let name = field(&settings.name, "Keep the name set in shoal", cx);
        let backends = field(&settings.backends.join(", "), "http://localhost:11434", cx);
        let concurrency = field(&settings.concurrency.to_string(), "1", cx);
        let subscriptions = [
            cx.observe(&controller, |this, _, cx| {
                this.update_token_placeholder(cx);
                cx.notify();
            }),
            cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
        ];
        // Job times tick even when nothing else changes.
        let ticker = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let ticked = this.update(cx, |this, cx| {
                    if !this.controller.read(cx).state().jobs.is_empty() {
                        cx.notify();
                    }
                });
                if ticked.is_err() {
                    break;
                }
            }
        });
        let mut this = Self {
            controller,
            server,
            token,
            name,
            backends,
            concurrency,
            launch_at_login,
            shows_saved_token: None,
            saving: false,
            saved: None,
            _subscriptions: subscriptions,
            _ticker: ticker,
        };
        this.update_token_placeholder(cx);
        if settings.server.is_empty() {
            window.focus(&this.server.focus_handle(cx));
        }
        this
    }

    fn update_token_placeholder(&mut self, cx: &mut Context<Self>) {
        let saved = self.controller.read(cx).has_token();
        if self.shows_saved_token.replace(saved) == Some(saved) {
            return;
        }
        let placeholder = if saved {
            "Saved in the keychain; type to replace"
        } else {
            "An API key from the shoal dashboard"
        };
        self.token.update(cx, |token, cx| token.set_placeholder(placeholder, cx));
    }

    fn save(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let edit = match self.edit(cx) {
            Ok(edit) => edit,
            Err(error) => {
                self.saved = Some(Err(error.into()));
                cx.notify();
                return;
            }
        };
        let applied = self.controller.update(cx, |controller, cx| controller.apply(edit, cx));
        self.saving = true;
        self.saved = Some(Ok("Saving…".into()));
        cx.spawn(async move |this, cx| {
            let result = applied.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                this.saved = Some(match result {
                    Ok(()) => {
                        this.token.update(cx, |token, cx| token.set_text("", cx));
                        Ok("Saved.".into())
                    }
                    Err(error) => Err(error.into()),
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The settings as entered, if they make sense.
    fn edit(&self, cx: &App) -> Result<Edit, String> {
        let text = |field: &Entity<TextField>| field.read(cx).text().trim().to_owned();
        let server = text(&self.server);
        if !(server.starts_with("ws://") || server.starts_with("wss://")) {
            return Err("The server URL must start with ws:// or wss://.".into());
        }
        let backends: Vec<String> = text(&self.backends)
            .split(',')
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .collect();
        if backends.is_empty() {
            return Err("Add at least one backend URL.".into());
        }
        if let Some(bad) =
            backends.iter().find(|url| !(url.starts_with("http://") || url.starts_with("https://")))
        {
            return Err(format!("Backend URLs must start with http:// or https:// ({bad})."));
        }
        let concurrency: NonZeroU32 = text(&self.concurrency)
            .parse()
            .map_err(|_| "Concurrent jobs must be a whole number above 0.".to_owned())?;
        let token = text(&self.token);
        Ok(Edit {
            server,
            token: (!token.is_empty()).then(|| Token::new(token)),
            name: text(&self.name),
            backends,
            concurrency,
            launch_at_login: self.launch_at_login,
        })
    }

    fn set_availability(&self, availability: Availability, cx: &mut Context<Self>) {
        self.controller.update(cx, |controller, cx| controller.set_availability(availability, cx));
    }

    fn status(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let controller = self.controller.read(cx);
        let status = controller.status();
        let accepting = controller.accepting();
        let paused = matches!(
            controller.state().availability.at(SystemTime::now()),
            Availability::PausedUntil(_)
        );

        let pause_buttons = PAUSES.iter().map(|&(label, minutes)| {
            button(SharedString::from(format!("pause-{minutes}")), label, theme, false).on_click(
                cx.listener(move |this, _, _, cx| {
                    let until = SystemTime::now() + Duration::from_secs(minutes * 60);
                    this.set_availability(Availability::PausedUntil(until), cx);
                }),
            )
        });
        let pause_row = div()
            .flex()
            .items_center()
            .gap_1()
            .text_sm()
            .child(div().text_color(theme.muted).mr_1().child(if paused {
                "Pause instead for"
            } else {
                "Pause for"
            }))
            .children(pause_buttons);

        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .min_w_0()
                            .child(
                                div()
                                    .flex_none()
                                    .size(px(10.))
                                    .rounded_full()
                                    .bg(theme.tone(status.tone)),
                            )
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(status.label),
                            ),
                    )
                    .child(switch("accepting", accepting, "Accept work", theme).on_click(
                        cx.listener(move |this, _, _, cx| {
                            let next = if accepting { Availability::Off } else { Availability::On };
                            this.set_availability(next, cx);
                        }),
                    )),
            )
            .when_some(status.detail, |this, detail| {
                this.child(div().text_sm().text_color(theme.muted).child(detail))
            })
            .child(pause_row)
    }

    fn jobs(&self, theme: Theme, cx: &App) -> Div {
        let jobs = &self.controller.read(cx).state().jobs;
        let now = Instant::now();
        let rows = jobs.iter().map(|job| {
            let elapsed = now.duration_since(job.started);
            let progress = match job.task {
                ModelTask::Chat if job.thinking => format!("Thinking · {} tokens", job.chunks),
                ModelTask::Chat => match format::rate(job.chunks, elapsed) {
                    Some(rate) => format!("{} tokens · {rate}", job.chunks),
                    None => format!("{} tokens", job.chunks),
                },
                ModelTask::Embedding | ModelTask::Image | ModelTask::Tts => "Working".to_owned(),
            };
            row(theme)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(div().truncate().child(job.model.clone()))
                        .child(div().text_sm().text_color(theme.muted).child(progress)),
                )
                .child(div().flex_none().text_sm().text_color(theme.muted).child(format!(
                    "{} · {}",
                    task_name(job.task),
                    format::elapsed(elapsed)
                )))
                .into_any_element()
        });
        section("Running jobs", theme).child(list(rows.collect(), "No jobs running.", theme))
    }

    fn models(&self, theme: Theme, cx: &App) -> Div {
        let inventory = &self.controller.read(cx).state().inventory;
        let rows = inventory.models.iter().map(|model| {
            let loaded = inventory.loaded.contains(&model.id);
            row(theme)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(div().truncate().child(model.id.clone()))
                        .child(div().text_sm().text_color(theme.muted).child(describe(model))),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap_1()
                        .text_sm()
                        .text_color(if loaded { theme.good } else { theme.muted })
                        .child(div().size(px(7.)).rounded_full().bg(if loaded {
                            theme.good
                        } else {
                            theme.border
                        }))
                        .child(if loaded { "Loaded" } else { "Not loaded" }),
                )
                .into_any_element()
        });
        section("Models", theme).child(list(
            rows.collect(),
            "No models found. Check that the backends are running.",
            theme,
        ))
    }

    fn settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let field = |label: &'static str, input: &Entity<TextField>| {
            div()
                .flex()
                .items_center()
                .gap_3()
                .child(div().flex_none().w(px(120.)).text_sm().text_color(theme.muted).child(label))
                .child(div().flex_1().min_w_0().child(input.clone()))
        };
        let launch_at_login = self.launch_at_login;
        section("Settings", theme)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(field("Server", &self.server))
                    .child(field("Token", &self.token))
                    .child(field("Name", &self.name))
                    .child(field("Backends", &self.backends))
                    .child(field("Concurrent jobs", &self.concurrency))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(div().flex_none().w(px(120.)))
                            .child(
                                checkbox(
                                    "launch-at-login",
                                    launch_at_login,
                                    "Launch at login",
                                    theme,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.launch_at_login = !launch_at_login;
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap_3()
                    .when_some(self.saved.clone(), |this, saved| {
                        let (color, note) = match saved {
                            Ok(note) => (theme.muted, note),
                            Err(error) => (theme.problem, error),
                        };
                        this.child(div().flex_1().text_sm().text_color(color).child(note))
                    })
                    .child(
                        button("save", "Save and connect", theme, true).on_click(
                            cx.listener(|this, _, window, cx| this.save(&Save, window, cx)),
                        ),
                    ),
            )
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        div()
            .id("main")
            .key_context("MainWindow")
            .on_action(cx.listener(Self::save))
            .on_action(|_: &FocusNext, window, _| window.focus_next())
            .on_action(|_: &FocusPrevious, window, _| window.focus_prev())
            .on_action(|_: &Close, window, _| window.remove_window())
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .text_color(theme.text)
            .text_size(px(14.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_6()
                    .p_6()
                    .child(self.status(theme, cx))
                    .child(self.jobs(theme, cx))
                    .child(self.models(theme, cx))
                    .child(self.settings(theme, cx)),
            )
    }
}

fn section(title: &'static str, theme: Theme) -> Div {
    div().flex().flex_col().gap_2().child(
        div()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.muted)
            .child(title.to_uppercase()),
    )
}

/// Rows in a bordered box, or a note when there are none.
fn list(rows: Vec<AnyElement>, empty: &'static str, theme: Theme) -> Div {
    let frame = div()
        .rounded_lg()
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden();
    if rows.is_empty() {
        frame.px_3().py_3().text_sm().text_color(theme.muted).child(empty)
    } else {
        frame.children(rows)
    }
}

fn row(theme: Theme) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap_3()
        .px_3()
        .py_2()
        .border_b_1()
        .border_color(theme.border)
}

fn button(
    id: impl Into<SharedString>,
    label: &'static str,
    theme: Theme,
    primary: bool,
) -> Stateful<Div> {
    let (bg, fg, border) = if primary {
        (theme.accent, theme.on_accent, theme.accent)
    } else {
        (theme.surface, theme.text, theme.border)
    };
    div()
        .id(id.into())
        .px_3()
        .py_1()
        .rounded_md()
        .border_1()
        .border_color(border)
        .bg(bg)
        .text_color(fg)
        .cursor_pointer()
        .hover(|style| style.opacity(0.85))
        .child(label)
}

fn switch(id: &'static str, on: bool, label: &'static str, theme: Theme) -> Stateful<Div> {
    let track: Hsla = if on { theme.good } else { theme.border };
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .cursor_pointer()
        .child(div().text_sm().text_color(theme.muted).child(label))
        .child(
            div()
                .flex()
                .items_center()
                .w(px(36.))
                .h(px(20.))
                .p(px(2.))
                .rounded_full()
                .bg(track)
                .when(on, Styled::justify_end)
                .child(div().size(px(16.)).rounded_full().bg(theme.on_accent)),
        )
}

fn checkbox(id: &'static str, checked: bool, label: &'static str, theme: Theme) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .cursor_pointer()
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(16.))
                .rounded_sm()
                .border_1()
                .border_color(if checked { theme.accent } else { theme.border })
                .bg(if checked { theme.accent } else { theme.surface })
                .text_color(theme.on_accent)
                .text_xs()
                .when(checked, |this| this.child("✓")),
        )
        .child(div().text_sm().child(label))
}

fn task_name(task: ModelTask) -> &'static str {
    match task {
        ModelTask::Chat => "chat",
        ModelTask::Embedding => "embedding",
        ModelTask::Image => "image",
        ModelTask::Tts => "speech",
    }
}

/// "chat · tools, vision", or "unknown" when the backend can't say.
fn describe(model: &WorkerModel) -> String {
    let purpose = model.purpose.map_or("unknown", |purpose| match purpose {
        shoal_worker::ModelPurpose::Chat => "chat",
        shoal_worker::ModelPurpose::Embedding => "embedding",
        shoal_worker::ModelPurpose::Image => "image",
        shoal_worker::ModelPurpose::Tts => "speech",
    });
    let capabilities: Vec<&str> = model
        .capabilities
        .iter()
        .flatten()
        .map(|capability| match capability {
            shoal_worker::ModelCapability::Tools => "tools",
            shoal_worker::ModelCapability::Vision => "vision",
            shoal_worker::ModelCapability::Thinking => "thinking",
        })
        .collect();
    if capabilities.is_empty() {
        purpose.to_owned()
    } else {
        format!("{purpose} · {}", capabilities.join(", "))
    }
}
