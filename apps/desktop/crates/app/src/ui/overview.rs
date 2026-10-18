//! The overview: whether work is on, what's running, and the models.

use std::time::{Duration, Instant};

use gpui::{Context, Div, FontWeight, Hsla, SharedString, Stateful, div, prelude::*, px};
use shoal_worker::{Availability, Connection, ModelTask};

use super::format;
use super::theme::{MONO, Theme, edge};
use super::widgets::{card, chip, dot, row, section_title, sparkline};
use super::window::{MainWindow, Page};
use crate::controller::Tone;

const PAUSES: [(&str, u64); 5] =
    [("10 min", 10), ("30 min", 30), ("1 hour", 60), ("3 hours", 180), ("8 hours", 480)];
/// Models shown here before "All models".
const MODELS_SHOWN: usize = 5;

impl MainWindow {
    pub(super) fn overview(&self, theme: Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        page()
            .child(self.banner(theme, cx))
            .when(self.choosing_pause, |this| this.child(self.pause_choices(theme, cx)))
            .child(self.stats(theme, cx))
            .child(self.running(theme, cx))
            .child(self.model_summary(theme, cx))
    }

    fn banner(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let controller = self.controller.read(cx);
        let status = controller.status();
        let state = controller.state();
        let availability = controller.availability();
        let (title, detail) = match (&state.connection, availability) {
            (Connection::Online { .. }, Availability::On) => {
                let since =
                    controller.online_since().map_or(Duration::ZERO, |since| since.elapsed());
                let detail = format!(
                    "Connected to {} for {} · {} of {} slots busy",
                    controller.server_host(),
                    format::elapsed(since),
                    state.jobs.len(),
                    controller.settings().concurrency
                );
                ("Accepting work".to_owned(), Some(detail))
            }
            _ => (status.label, status.detail),
        };
        let color = theme.tone(status.tone);
        let lit = status.tone == Tone::Good;

        div()
            .flex()
            .items_center()
            .justify_between()
            .gap_5()
            .px(px(22.))
            .py_5()
            .rounded_xl()
            .border_1()
            .when(lit, |this| this.border_color(edge(theme.lumen)).bg(theme.lumen.opacity(0.06)))
            .when(!lit, |this| this.border_color(theme.line).bg(theme.shelf))
            .child(
                div().flex().items_center().gap_4().min_w_0().child(halo(color, lit)).child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .min_w_0()
                        .child(
                            div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).child(title),
                        )
                        .when_some(detail, |this, detail| {
                            this.child(div().text_sm().text_color(theme.secondary).child(detail))
                        }),
                ),
            )
            .child(self.availability_control(availability, theme, cx))
    }

    /// On, Pause (which opens the durations) and Off.
    fn availability_control(
        &self,
        availability: Availability,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let segment = |id: &'static str, label: &'static str, active: bool| {
            div()
                .id(id)
                .flex()
                .items_center()
                .h(px(30.))
                .px(px(14.))
                .rounded_md()
                .cursor_pointer()
                .text_sm()
                .when(active, |this| {
                    this.bg(theme.lumen)
                        .text_color(theme.lumen_ink)
                        .font_weight(FontWeight::SEMIBOLD)
                })
                .when(!active, |this| {
                    this.text_color(theme.secondary)
                        .hover(move |style| style.text_color(theme.text))
                })
                .child(label)
        };
        let (on, paused, off) = match availability {
            Availability::On => (true, false, false),
            Availability::PausedUntil(_) => (false, true, false),
            Availability::Off => (false, false, true),
        };
        let pause_label = if self.choosing_pause { "Pause ▴" } else { "Pause ▾" };

        div()
            .flex()
            .flex_none()
            .gap_0p5()
            .p(px(3.))
            .rounded_lg()
            .border_1()
            .border_color(theme.line)
            .bg(theme.trench)
            .child(segment("availability-on", "On", on).on_click(cx.listener(|this, _, _, cx| {
                this.choosing_pause = false;
                this.controller.update(cx, |c, cx| c.set_availability(Availability::On, cx));
            })))
            .child(segment("availability-pause", pause_label, paused).on_click(cx.listener(
                |this, _, _, cx| {
                    this.choosing_pause = !this.choosing_pause;
                    cx.notify();
                },
            )))
            .child(segment("availability-off", "Off", off).on_click(cx.listener(
                |this, _, _, cx| {
                    this.choosing_pause = false;
                    this.controller.update(cx, |c, cx| c.set_availability(Availability::Off, cx));
                },
            )))
    }

    fn pause_choices(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let paused =
            matches!(self.controller.read(cx).availability(), Availability::PausedUntil(_));
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(div().text_sm().text_color(theme.secondary).mr_1().child(if paused {
                "Pause instead for"
            } else {
                "Pause for"
            }))
            .children(PAUSES.iter().map(|&(label, minutes)| {
                div()
                    .id(SharedString::from(format!("pause-{minutes}")))
                    .px_3()
                    .py_1()
                    .rounded_full()
                    .border_1()
                    .border_color(theme.line_strong)
                    .bg(theme.shelf)
                    .text_sm()
                    .cursor_pointer()
                    .hover(move |style| style.border_color(theme.lumen))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choosing_pause = false;
                        this.controller
                            .update(cx, |c, cx| c.pause_for(Duration::from_secs(minutes * 60), cx));
                    }))
            }))
    }

    fn stats(&self, theme: Theme, cx: &Context<Self>) -> Div {
        let controller = self.controller.read(cx);
        let state = controller.state();
        let stat = |label: &'static str, value: String, of: Option<String>| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .px_4()
                .py(px(14.))
                .rounded_lg()
                .border_1()
                .border_color(theme.line)
                .bg(theme.shelf)
                .child(div().text_xs().text_color(theme.tertiary).child(label))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .font_family(MONO)
                        .text_size(px(22.))
                        .child(value)
                        .when_some(of, |this, of| {
                            this.child(
                                div()
                                    .text_size(px(15.))
                                    .text_color(theme.tertiary)
                                    .child(format!("/{of}")),
                            )
                        }),
                )
        };
        div()
            .grid()
            .grid_cols(4)
            .gap_3()
            .child(stat(
                "Running",
                state.jobs.len().to_string(),
                Some(controller.settings().concurrency.to_string()),
            ))
            .child(stat("Completed", format::count(state.jobs_completed), None))
            .child(stat("Tokens out", format::count(state.tokens_out), None))
            .child(stat(
                "Models loaded",
                state.inventory.loaded.len().to_string(),
                Some(state.inventory.models.len().to_string()),
            ))
    }

    fn running(&self, theme: Theme, cx: &Context<Self>) -> Div {
        let jobs = &self.controller.read(cx).state().jobs;
        let now = Instant::now();
        let rows = jobs.iter().enumerate().map(|(i, job)| {
            let elapsed = now.duration_since(job.started);
            let color = if job.thinking { theme.amber } else { theme.lumen };
            let samples: Vec<f32> = self
                .rates
                .get(&job.id)
                .map(|rate| rate.samples.iter().copied().collect())
                .unwrap_or_default();
            let recent = &samples[samples.len().saturating_sub(5)..];
            #[expect(clippy::cast_precision_loss, reason = "five samples")]
            let rate =
                (!recent.is_empty()).then(|| recent.iter().sum::<f32>() / recent.len() as f32);
            let (label, chip_color) = match job.task {
                ModelTask::Chat if job.thinking => ("thinking", theme.amber),
                task => (task_name(task), theme.current),
            };
            row(theme, i + 1 == jobs.len())
                .py(px(14.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    div()
                                        .font_family(MONO)
                                        .text_size(px(14.))
                                        .truncate()
                                        .child(job.model.clone()),
                                )
                                .child(chip(label, chip_color)),
                        )
                        .when(job.task == ModelTask::Chat, |this| {
                            this.child(sparkline(samples.clone(), color, 220., 18.))
                        }),
                )
                .child(
                    mono(format!("{} tokens", format::count(job.chunks)), theme.secondary)
                        .w(px(110.)),
                )
                .child(
                    mono(rate.map_or_else(|| "–".to_owned(), |r| format!("{r:.1} tok/s")), color)
                        .w(px(100.)),
                )
                .child(
                    mono(format::elapsed(elapsed), theme.tertiary).w(px(60.)).flex().justify_end(),
                )
        });
        div().flex().flex_col().gap(px(10.)).child(section_title("Running now", theme)).child(
            if jobs.is_empty() {
                card(theme)
                    .px_4()
                    .py_4()
                    .text_sm()
                    .text_color(theme.tertiary)
                    .child("No jobs running. They appear here as the server sends them.")
            } else {
                card(theme).children(rows)
            },
        )
    }

    fn model_summary(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let inventory = &self.controller.read(cx).state().inventory;
        let shown = inventory.models.len().min(MODELS_SHOWN);
        let rows = inventory.models.iter().take(shown).enumerate().map(|(i, model)| {
            let loaded = inventory.loaded.contains(&model.id);
            row(theme, i + 1 == shown)
                .child(loaded_dot(loaded, theme))
                .child(
                    div().flex_1().min_w_0().font_family(MONO).truncate().child(model.id.clone()),
                )
                .child(div().text_xs().text_color(theme.secondary).child(super::describe(model)))
                .child(
                    div()
                        .w(px(74.))
                        .flex()
                        .justify_end()
                        .text_xs()
                        .text_color(if loaded { theme.lumen } else { theme.tertiary })
                        .child(if loaded { "Loaded" } else { "Idle" }),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(section_title("Models", theme))
                    .child(
                        div()
                            .id("all-models")
                            .text_xs()
                            .text_color(theme.lumen)
                            .cursor_pointer()
                            .child("All models →")
                            .on_click(cx.listener(|this, _, _, cx| this.go(Page::Models, cx))),
                    ),
            )
            .child(if shown == 0 {
                card(theme)
                    .px_4()
                    .py_4()
                    .text_sm()
                    .text_color(theme.tertiary)
                    .child("No models found yet. Check the backends in Settings.")
            } else {
                card(theme).children(rows)
            })
    }
}

/// A scrolling page body.
pub(super) fn page() -> Stateful<Div> {
    div()
        .id("page")
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .gap(px(22.))
        .px(px(30.))
        .pt_3()
        .pb(px(26.))
}

pub(super) fn mono(text: String, color: Hsla) -> Div {
    div().flex_none().font_family(MONO).text_sm().text_color(color).child(text)
}

pub(super) fn loaded_dot(loaded: bool, theme: Theme) -> Div {
    if loaded {
        dot(theme.lumen, 8.)
    } else {
        div().flex_none().size(px(8.)).rounded_full().border_1().border_color(theme.line_strong)
    }
}

pub(super) fn task_name(task: ModelTask) -> &'static str {
    match task {
        ModelTask::Chat => "chat",
        ModelTask::Embedding => "embedding",
        ModelTask::Image => "image",
        ModelTask::Tts => "speech",
    }
}

/// The status light, haloed while working.
fn halo(color: Hsla, lit: bool) -> Div {
    div()
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .size(px(22.))
        .rounded_full()
        .when(lit, |this| this.bg(color.opacity(0.16)))
        .child(dot(color, 12.))
}
