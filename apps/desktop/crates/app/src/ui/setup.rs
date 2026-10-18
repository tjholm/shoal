//! First run: the server, the token and which local backends to serve.

use gpui::{
    Context, Div, Entity, EventEmitter, Focusable, FontWeight, SharedString, Window, div,
    prelude::*, px, svg,
};
use shoal_worker::{BackendStatus, Token};

use super::settings::{mono_field, validate_backends, validate_server};
use super::text_field::TextField;
use super::theme::{MONO, Theme, edge};
use super::widgets::{Kind, button, glyph};
use super::window::Save;
use crate::controller::{Controller, Edit};

/// Emitted once the settings are saved and the worker is connecting.
pub struct Connected;

pub struct SetupPage {
    controller: Entity<Controller>,
    server: Entity<TextField>,
    token: Entity<TextField>,
    other_backend: Entity<TextField>,
    /// Backends answering on the usual local ports, and whether to use each;
    /// `None` while looking.
    found: Option<Vec<(BackendStatus, bool)>>,
    saving: bool,
    error: Option<SharedString>,
}

impl EventEmitter<Connected> for SetupPage {}

impl SetupPage {
    pub fn new(
        controller: Entity<Controller>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let server_url = controller.read(cx).settings().server.clone();
        let server =
            cx.new(|cx| TextField::new(&server_url, "wss://shoal.example.com/ws/workers", cx));
        let token = cx.new(|cx| TextField::new("", "Paste an API key", cx).masked());
        let other_backend = cx.new(|cx| TextField::new("", "Another backend URL (optional)", cx));
        window
            .focus(&if server_url.is_empty() { &server } else { &token }.read(cx).focus_handle(cx));

        let probe = controller.read(cx).detect_backends();
        cx.spawn(async move |this, cx| {
            let found = probe.await;
            let _ = this.update(cx, |this, cx| {
                let reachable = found.into_iter().filter(|backend| backend.kind.is_some());
                this.found = Some(reachable.map(|backend| (backend, true)).collect());
                cx.notify();
            });
        })
        .detach();

        Self { controller, server, token, other_backend, found: None, saving: false, error: None }
    }

    fn connect(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let edit = match self.edit(cx) {
            Ok(edit) => edit,
            Err(error) => {
                self.error = Some(error.into());
                cx.notify();
                return;
            }
        };
        let applied = self.controller.update(cx, |controller, cx| controller.apply(edit, cx));
        self.saving = true;
        self.error = None;
        cx.spawn(async move |this, cx| {
            let result = applied.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(()) => cx.emit(Connected),
                    Err(error) => this.error = Some(error.into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn edit(&self, cx: &Context<Self>) -> Result<Edit, String> {
        let text = |field: &Entity<TextField>| field.read(cx).text().trim().to_owned();
        let server = validate_server(&text(&self.server))?;
        let token = text(&self.token);
        if token.is_empty() && !self.controller.read(cx).has_token() {
            return Err("Paste the API key.".into());
        }
        let mut backends: Vec<String> = self
            .found
            .iter()
            .flatten()
            .filter(|(_, chosen)| *chosen)
            .map(|(backend, _)| backend.url.clone())
            .collect();
        let other = text(&self.other_backend);
        if !other.is_empty() {
            backends.push(other);
        }
        let settings = self.controller.read(cx).settings();
        Ok(Edit {
            server,
            token: (!token.is_empty()).then(|| Token::new(token)),
            name: settings.name.clone(),
            dashboard: settings.dashboard.clone(),
            backends: validate_backends(backends)?,
            concurrency: settings.concurrency,
            launch_at_login: self.controller.read(cx).launch_at_login(),
        })
    }

    fn found(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let list = div().flex().flex_col().gap_2();
        match &self.found {
            None => list.child(
                div()
                    .text_sm()
                    .text_color(theme.tertiary)
                    .child("Looking for backends on this computer…"),
            ),
            Some(found) if found.is_empty() => list.child(
                div()
                    .text_sm()
                    .text_color(theme.tertiary)
                    .child("None found on the usual ports. Add a URL below."),
            ),
            Some(found) => list.children(found.iter().enumerate().map(|(i, (backend, chosen))| {
                let chosen = *chosen;
                let models = match backend.models.len() {
                    1 => "1 model".to_owned(),
                    n => format!("{n} models"),
                };
                let host = backend.url.trim_start_matches("http://").to_owned();
                div()
                    .id(SharedString::from(format!("found-{i}")))
                    .flex()
                    .items_center()
                    .gap_3()
                    .px(px(14.))
                    .py(px(11.))
                    .rounded_lg()
                    .border_1()
                    .cursor_pointer()
                    .when(chosen, |this| {
                        this.border_color(edge(theme.lumen)).bg(theme.lumen.opacity(0.06))
                    })
                    .when(!chosen, |this| this.border_color(theme.line).bg(theme.shelf))
                    .child(checkbox(chosen, theme))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().text_sm().child(backend.kind.unwrap_or("Backend")))
                            .child(
                                div()
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.secondary)
                                    .child(format!("{host} · {models}")),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some((_, chosen)) =
                            this.found.as_mut().and_then(|found| found.get_mut(i))
                        {
                            *chosen = !*chosen;
                        }
                        cx.notify();
                    }))
            })),
        }
    }
}

impl Render for SetupPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let field = |label: &'static str, input: Div| {
            div()
                .flex()
                .flex_col()
                .gap(px(7.))
                .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
                .child(input)
        };
        div()
            .key_context("SetupPage")
            .on_action(cx.listener(Self::connect))
            .id("setup")
            .size_full()
            .overflow_y_scroll()
            .flex()
            .justify_center()
            .pt(px(56.))
            .pb_10()
            .child(
                div()
                    .w(px(460.))
                    .flex()
                    .flex_col()
                    .gap_6()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(14.))
                            .child(glyph(56., theme.secondary, Some(theme.lumen)))
                            .child(div().text_size(px(26.)).font_weight(FontWeight::SEMIBOLD).child("Join this computer to your shoal"))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .text_color(theme.secondary)
                                    .text_center()
                                    .child("It serves jobs from the models you run locally, and lives in the menu bar once connected."),
                            ),
                    )
                    .child(field("Worker URL", mono_field(&self.server)))
                    .child(
                        field("API key", mono_field(&self.token)).child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_xs()
                                .text_color(theme.tertiary)
                                .child(svg().path("icons/lock.svg").size(px(12.)).text_color(theme.tertiary))
                                .child("Kept in the Keychain, never in a file or your shell history."),
                        ),
                    )
                    .child(field("Backends found on this computer", self.found(theme, cx)).child(mono_field(&self.other_backend)))
                    .when_some(self.error.clone(), |this, error| {
                        this.child(div().text_sm().text_color(theme.coral).child(error))
                    })
                    .child(
                        button("connect", if self.saving { "Connecting…" } else { "Connect" }, Kind::Primary, theme)
                            .h(px(40.))
                            .text_size(px(14.))
                            .on_click(cx.listener(|this, _, window, cx| this.connect(&Save, window, cx))),
                    ),
            )
    }
}

fn checkbox(checked: bool, theme: Theme) -> Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(16.))
        .rounded_sm()
        .border_1()
        .border_color(if checked { theme.lumen } else { theme.line_strong })
        .bg(if checked { theme.lumen } else { theme.trench })
        .text_color(theme.lumen_ink)
        .text_xs()
        .when(checked, |this| this.child("✓"))
}
