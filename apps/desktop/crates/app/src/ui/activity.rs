//! Jobs that have ended, newest first.

use gpui::{Context, Div, FontWeight, Stateful, div, prelude::*, px};
use shoal_worker::Outcome;

use super::format;
use super::overview::{mono, page, task_name};
use super::theme::{MONO, Theme};
use super::widgets::{card, chip, dot, row};
use super::window::MainWindow;

impl MainWindow {
    pub(super) fn activity(&self, theme: Theme, cx: &Context<Self>) -> Stateful<Div> {
        let recent = &self.controller.read(cx).state().recent;
        let rows = recent.iter().enumerate().map(|(i, job)| {
            let (label, color) = match &job.outcome {
                Outcome::Done => ("done", theme.lumen),
                Outcome::Failed(_) => ("failed", theme.coral),
                Outcome::Cancelled => ("cancelled", theme.tertiary),
                Outcome::Abandoned => ("abandoned", theme.amber),
            };
            let failure = match &job.outcome {
                Outcome::Failed(reason) => Some(reason.clone()),
                _ => None,
            };
            row(theme, i + 1 == recent.len())
                .items_start()
                .child(div().pt(px(5.)).child(dot(color, 8.)))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(div().font_family(MONO).truncate().child(job.model.clone()))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.tertiary)
                                        .child(task_name(job.task)),
                                )
                                .child(chip(label, color)),
                        )
                        .when_some(failure, |this, failure| {
                            this.child(div().text_xs().text_color(theme.secondary).child(failure))
                        }),
                )
                .child(
                    mono(format!("{} tokens", format::count(job.tokens)), theme.secondary)
                        .w(px(100.)),
                )
                .child(mono(format::elapsed(job.duration), theme.tertiary).w(px(64.)))
                .child(
                    mono(format::clock(job.ended), theme.tertiary).w(px(110.)).flex().justify_end(),
                )
        });
        page()
            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child("Activity"))
            .child(
                div()
                    .text_sm()
                    .text_color(theme.secondary)
                    .child("The last 50 jobs since Shoal started."),
            )
            .child(if recent.is_empty() {
                card(theme).px_4().py_4().text_sm().text_color(theme.tertiary).child("No jobs yet.")
            } else {
                card(theme).children(rows)
            })
    }
}
