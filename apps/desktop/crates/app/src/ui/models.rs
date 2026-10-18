//! Every model, grouped by the backend serving it.

use gpui::{Context, Div, FontWeight, Stateful, div, prelude::*, px};
use shoal_worker::BackendStatus;

use super::overview::{loaded_dot, page};
use super::theme::{MONO, Theme};
use super::widgets::{card, chip, row};
use super::window::MainWindow;

impl MainWindow {
    pub(super) fn models(&self, theme: Theme, cx: &Context<Self>) -> Stateful<Div> {
        let inventory = &self.controller.read(cx).state().inventory;
        let sections = inventory.backends.iter().map(|backend| {
            let rows: Vec<Div> = backend
                .models
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let loaded = backend.loaded.contains(id);
                    let description = inventory
                        .models
                        .iter()
                        .find(|model| &model.id == id)
                        .map_or_else(|| "served by an earlier backend".to_owned(), super::describe);
                    row(theme, i + 1 == backend.models.len())
                        .child(loaded_dot(loaded, theme))
                        .child(
                            div().flex_1().min_w_0().font_family(MONO).truncate().child(id.clone()),
                        )
                        .child(div().text_xs().text_color(theme.secondary).child(description))
                        .child(
                            div()
                                .w(px(74.))
                                .flex()
                                .justify_end()
                                .text_xs()
                                .text_color(if loaded { theme.lumen } else { theme.tertiary })
                                .child(if loaded { "Loaded" } else { "Idle" }),
                        )
                })
                .collect();
            div().flex().flex_col().gap(px(10.)).child(header(backend, theme)).child(
                match (&backend.error, rows.is_empty()) {
                    (Some(error), _) => card(theme)
                        .px_4()
                        .py_3()
                        .text_sm()
                        .text_color(theme.tertiary)
                        .child(error.clone()),
                    (None, true) => card(theme)
                        .px_4()
                        .py_3()
                        .text_sm()
                        .text_color(theme.tertiary)
                        .child("No models."),
                    (None, false) => card(theme).children(rows),
                },
            )
        });
        let body = page()
            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child("Models"));
        if inventory.backends.is_empty() {
            body.child(
                div().text_sm().text_color(theme.tertiary).child("No backends configured yet."),
            )
        } else {
            body.children(sections)
        }
    }
}

fn header(backend: &BackendStatus, theme: Theme) -> Div {
    let (label, color) = match backend.kind {
        Some(_) => ("Reachable", theme.lumen),
        None => ("Not responding", theme.coral),
    };
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(backend.kind.unwrap_or("Backend")),
        )
        .child(
            div().font_family(MONO).text_xs().text_color(theme.tertiary).child(backend.url.clone()),
        )
        .child(div().flex_1())
        .child(chip(label, color))
}
