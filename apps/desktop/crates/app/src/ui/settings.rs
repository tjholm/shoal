//! Settings: the server and token, backends, capacity and launch at login.

use std::num::NonZeroU32;

use gpui::{
    App, Context, Div, Entity, Focusable, FontWeight, SharedString, Window, div, prelude::*, px,
    svg,
};
use shoal_worker::{BackendStatus, Token};

use super::text_field::TextField;
use super::theme::{MONO, Theme};
use super::widgets::{Kind, button, card, chip, row, section_title, switch};
use super::window::Save;
use crate::controller::{Controller, Edit};

const MAX_CONCURRENCY: u32 = 64;

pub struct SettingsPage {
    controller: Entity<Controller>,
    server: Entity<TextField>,
    token: Entity<TextField>,
    /// Whether the token field is open, replacing a saved token.
    replacing_token: bool,
    name: Entity<TextField>,
    dashboard: Entity<TextField>,
    backends: Vec<String>,
    new_backend: Entity<TextField>,
    concurrency: NonZeroU32,
    launch_at_login: bool,
    saving: bool,
    /// The outcome of the last save: `Ok` with a note, or the error.
    saved: Option<Result<SharedString, SharedString>>,
}

impl SettingsPage {
    pub fn new(controller: Entity<Controller>, cx: &mut Context<Self>) -> Self {
        let field = |placeholder: &'static str, cx: &mut Context<Self>| {
            cx.new(|cx| TextField::new("", placeholder, cx))
        };
        let mut this = Self {
            server: field("wss://shoal.example.com/ws/workers", cx),
            token: cx
                .new(|cx| TextField::new("", "An API key from the shoal dashboard", cx).masked()),
            replacing_token: false,
            name: field("Keep the name set in shoal", cx),
            dashboard: field("https://shoal.example.com (optional)", cx),
            backends: Vec::new(),
            new_backend: field("http://localhost:1234", cx),
            concurrency: NonZeroU32::MIN,
            launch_at_login: false,
            saving: false,
            saved: None,
            controller,
        };
        this.revert(cx);
        this
    }

    /// Back to what's saved.
    fn revert(&mut self, cx: &mut Context<Self>) {
        let (settings, launch_at_login) = {
            let controller = self.controller.read(cx);
            (controller.settings().clone(), controller.launch_at_login())
        };
        let set = |field: &Entity<TextField>, text: &str, cx: &mut Context<Self>| {
            field.update(cx, |field, cx| field.set_text(text, cx));
        };
        set(&self.server, &settings.server, cx);
        set(&self.token, "", cx);
        set(&self.name, &settings.name, cx);
        set(&self.dashboard, &settings.dashboard, cx);
        set(&self.new_backend, "", cx);
        self.replacing_token = false;
        self.backends = settings.backends;
        self.concurrency = settings.concurrency;
        self.launch_at_login = launch_at_login;
        self.saved = None;
        cx.notify();
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
                if result.is_ok() {
                    this.token.update(cx, |token, cx| token.set_text("", cx));
                    this.replacing_token = false;
                }
                this.saved = Some(result.map(|()| "Saved.".into()).map_err(Into::into));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The settings as entered, if they make sense.
    fn edit(&self, cx: &App) -> Result<Edit, String> {
        let text = |field: &Entity<TextField>| field.read(cx).text().trim().to_owned();
        let server = validate_server(&text(&self.server))?;
        let mut backends = self.backends.clone();
        let pending = text(&self.new_backend);
        if !pending.is_empty() {
            backends.push(pending);
        }
        let backends = validate_backends(backends)?;
        let dashboard = text(&self.dashboard);
        if !(dashboard.is_empty()
            || dashboard.starts_with("http://")
            || dashboard.starts_with("https://"))
        {
            return Err("The dashboard URL must start with http:// or https://.".into());
        }
        let token = text(&self.token);
        Ok(Edit {
            server,
            token: (!token.is_empty()).then(|| Token::new(token)),
            name: text(&self.name),
            dashboard,
            backends,
            concurrency: self.concurrency,
            launch_at_login: self.launch_at_login,
        })
    }

    fn add_backend(&mut self, cx: &mut Context<Self>) {
        let url = self.new_backend.read(cx).text().trim().to_owned();
        if url.is_empty() {
            return;
        }
        match validate_backends(vec![url]) {
            Ok(mut url) => {
                self.backends.append(&mut url);
                self.new_backend.update(cx, |field, cx| field.set_text("", cx));
                self.saved = None;
            }
            Err(error) => self.saved = Some(Err(error.into())),
        }
        cx.notify();
    }

    fn server_section(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let has_token = self.controller.read(cx).has_token();
        let token = if has_token && !self.replacing_token {
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .items_center()
                        .gap_2()
                        .h(px(34.))
                        .px(px(11.))
                        .rounded_md()
                        .border_1()
                        .border_color(theme.line)
                        .bg(theme.trench)
                        .child(svg().path("icons/lock.svg").size(px(14.)).text_color(theme.lumen))
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.secondary)
                                .child("Saved in the Keychain"),
                        ),
                )
                .child(button("replace-token", "Replace…", Kind::Secondary, theme).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.replacing_token = true;
                        window.focus(&this.token.read(cx).focus_handle(cx));
                        cx.notify();
                    }),
                ))
        } else {
            div().flex().items_center().gap(px(10.)).child(mono_field(&self.token)).when(
                self.replacing_token,
                |this| {
                    this.child(button("keep-token", "Keep saved", Kind::Secondary, theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.replacing_token = false;
                            this.token.update(cx, |token, cx| token.set_text("", cx));
                            cx.notify();
                        }),
                    ))
                },
            )
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(section_title("Server", theme))
            .child(labelled("Worker URL", mono_field(&self.server), theme))
            .child(labelled("Token", token, theme))
            .child(labelled("Worker name", div().flex_1().child(self.name.clone()), theme))
            .child(labelled("Dashboard", mono_field(&self.dashboard), theme))
    }

    fn backends_section(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let statuses = &self.controller.read(cx).state().inventory.backends;
        let count = self.backends.len();
        let rows = self.backends.iter().enumerate().map(|(i, url)| {
            let status = statuses.iter().find(|status| status.url == url.trim_end_matches('/'));
            let (summary, badge) = describe_backend(status, theme);
            row(theme, i + 1 == count)
                .py(px(12.))
                .child(
                    div()
                        .w(px(14.))
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.tertiary)
                        .child((i + 1).to_string()),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .flex_1()
                        .min_w_0()
                        .child(div().font_family(MONO).truncate().child(url.clone()))
                        .child(div().text_xs().text_color(theme.secondary).child(summary)),
                )
                .when_some(badge, Div::child)
                .child(
                    button(
                        SharedString::from(format!("remove-backend-{i}")),
                        "×",
                        Kind::Secondary,
                        theme,
                    )
                    .w(px(32.))
                    .px_0()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.backends.remove(i);
                        cx.notify();
                    })),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(section_title("Backends", theme))
            .child(if count == 0 {
                card(theme)
                    .px_4()
                    .py_3()
                    .text_sm()
                    .text_color(theme.tertiary)
                    .child("No backends. Add one below.")
            } else {
                card(theme).children(rows)
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(mono_field(&self.new_backend))
                    .child(
                        button("add-backend", "Add backend", Kind::Secondary, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.add_backend(cx))),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.tertiary)
                    .child("Jobs go to the first backend that has the model."),
            )
    }

    fn options_section(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let option = |title: &'static str, hint: &'static str| {
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap_3()
                .px_4()
                .py(px(14.))
                .rounded_lg()
                .border_1()
                .border_color(theme.line)
                .bg(theme.shelf)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(div().text_sm().child(title))
                        .child(div().text_xs().text_color(theme.tertiary).child(hint)),
                )
        };
        let step = |id: &'static str, label: &'static str, delta: i32, cx: &mut Context<Self>| {
            div()
                .id(id)
                .flex()
                .items_center()
                .justify_center()
                .w(px(32.))
                .h(px(30.))
                .bg(theme.reef)
                .cursor_pointer()
                .hover(move |style| style.bg(theme.line))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let next = this
                        .concurrency
                        .get()
                        .saturating_add_signed(delta)
                        .clamp(1, MAX_CONCURRENCY);
                    this.concurrency = NonZeroU32::new(next).unwrap_or(NonZeroU32::MIN);
                    cx.notify();
                }))
        };
        let launch_at_login = self.launch_at_login;
        div()
            .grid()
            .grid_cols(2)
            .gap_3()
            .child(
                option("Concurrent jobs", "Advertised to the server").child(
                    div()
                        .flex()
                        .items_center()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.line_strong)
                        .overflow_hidden()
                        .child(step("fewer-jobs", "−", -1, cx))
                        .child(
                            div()
                                .w(px(36.))
                                .flex()
                                .justify_center()
                                .font_family(MONO)
                                .text_size(px(14.))
                                .child(self.concurrency.to_string()),
                        )
                        .child(step("more-jobs", "+", 1, cx)),
                ),
            )
            .child(option("Launch at login", "Starts in the menu bar").child(
                switch("launch-at-login", launch_at_login, theme).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.launch_at_login = !launch_at_login;
                        cx.notify();
                    },
                )),
            ))
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let note = match &self.saved {
            Some(Ok(note)) => div().text_xs().text_color(theme.secondary).child(note.clone()),
            Some(Err(error)) => div().text_xs().text_color(theme.coral).child(error.clone()),
            None => div()
                .text_xs()
                .text_color(theme.tertiary)
                .child("Changing the server or token reconnects; running jobs are abandoned."),
        };
        div()
            .key_context("SettingsPage")
            .on_action(cx.listener(Self::save))
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .id("settings")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .gap(px(26.))
                    .px(px(30.))
                    .pt_3()
                    .pb(px(26.))
                    .child(
                        div()
                            .text_size(px(20.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Settings"),
                    )
                    .child(self.server_section(theme, cx))
                    .child(self.backends_section(theme, cx))
                    .child(self.options_section(theme, cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_3()
                    .px(px(30.))
                    .py(px(14.))
                    .border_t_1()
                    .border_color(theme.line)
                    .bg(theme.trench)
                    .child(note.flex_1().min_w_0())
                    .child(
                        button("revert", "Revert", Kind::Secondary, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.revert(cx))),
                    )
                    .child(
                        button(
                            "save",
                            if self.saving { "Saving…" } else { "Save and reconnect" },
                            Kind::Primary,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.save(&Save, window, cx))),
                    ),
            )
    }
}

fn labelled(label: &'static str, input: Div, theme: Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap_4()
        .child(div().flex_none().w(px(110.)).text_sm().text_color(theme.secondary).child(label))
        .child(div().flex().flex_1().min_w_0().child(input))
}

pub(super) fn mono_field(field: &Entity<TextField>) -> Div {
    div().flex_1().min_w_0().font_family(MONO).child(field.clone())
}

/// "Ollama · 5 models · 2 loaded", and a badge when it isn't answering.
fn describe_backend(status: Option<&BackendStatus>, theme: Theme) -> (String, Option<Div>) {
    match status {
        None => ("Not probed yet".to_owned(), None),
        Some(BackendStatus { kind: None, .. }) => {
            ("Not responding".to_owned(), Some(chip("Not responding", theme.coral)))
        }
        Some(BackendStatus { kind: Some(kind), models, loaded, .. }) => {
            let models = match models.len() {
                1 => "1 model".to_owned(),
                n => format!("{n} models"),
            };
            (
                format!("{kind} · {models} · {} loaded", loaded.len()),
                Some(chip("Reachable", theme.lumen)),
            )
        }
    }
}

pub(super) fn validate_server(server: &str) -> Result<String, String> {
    if server.starts_with("ws://") || server.starts_with("wss://") {
        Ok(server.to_owned())
    } else {
        Err("The worker URL must start with ws:// or wss://.".into())
    }
}

pub(super) fn validate_backends(backends: Vec<String>) -> Result<Vec<String>, String> {
    if backends.is_empty() {
        return Err("Add at least one backend URL.".into());
    }
    match backends.iter().find(|url| !(url.starts_with("http://") || url.starts_with("https://"))) {
        Some(bad) => Err(format!("Backend URLs must start with http:// or https:// ({bad}).")),
        None => Ok(backends),
    }
}
