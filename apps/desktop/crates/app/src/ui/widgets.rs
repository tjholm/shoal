//! Small building blocks shared by the window's pages.

use gpui::{
    Div, ElementId, FontWeight, Hsla, PathBuilder, SharedString, Stateful, canvas, div, point,
    prelude::*, px, svg,
};

use super::theme::{Theme, edge, wash};

/// The shoal glyph: three fish around a hub, which is lit or left out.
pub fn glyph(size: f32, fish: Hsla, hub: Option<Hsla>) -> Div {
    let layer = |path: &'static str, color: Hsla| {
        svg().path(path).absolute().top_0().left_0().size(px(size)).text_color(color)
    };
    div()
        .relative()
        .flex_none()
        .size(px(size))
        .child(layer("glyph-fish.svg", fish))
        .when_some(hub, |this, hub| this.child(layer("glyph-hub.svg", hub)))
}

pub fn section_title(title: &'static str, theme: Theme) -> Div {
    div()
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.tertiary)
        .child(title.to_uppercase())
}

/// A bordered box for rows.
pub fn card(theme: Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .rounded_lg()
        .border_1()
        .border_color(theme.line)
        .bg(theme.shelf)
        .overflow_hidden()
}

/// A row in a [`card`]; all but the last are ruled off.
pub fn row(theme: Theme, last: bool) -> Div {
    div()
        .flex()
        .items_center()
        .gap_3()
        .px_4()
        .py(px(11.))
        .when(!last, |this| this.border_b_1().border_color(theme.line))
}

pub fn chip(label: impl Into<SharedString>, color: Hsla) -> Div {
    div()
        .flex_none()
        .px_2()
        .py(px(2.))
        .rounded_full()
        .border_1()
        .border_color(edge(color))
        .bg(wash(color))
        .text_color(color)
        .text_xs()
        .child(label.into())
}

pub fn dot(color: Hsla, size: f32) -> Div {
    div().flex_none().size(px(size)).rounded_full().bg(color)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Primary,
    Secondary,
}

pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    kind: Kind,
    theme: Theme,
) -> Stateful<Div> {
    let base = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .h(px(32.))
        .px(px(14.))
        .rounded_md()
        .text_sm()
        .cursor_pointer()
        .child(label.into());
    match kind {
        Kind::Primary => base
            .bg(theme.lumen)
            .text_color(theme.lumen_ink)
            .font_weight(FontWeight::SEMIBOLD)
            .hover(|style| style.opacity(0.9)),
        Kind::Secondary => base
            .bg(theme.reef)
            .border_1()
            .border_color(theme.line_strong)
            .text_color(theme.text)
            .hover(move |style| style.border_color(theme.tertiary)),
    }
}

pub fn switch(id: impl Into<ElementId>, on: bool, theme: Theme) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .w(px(38.))
        .h(px(22.))
        .p(px(2.))
        .rounded_full()
        .cursor_pointer()
        .bg(if on { theme.lumen } else { theme.line_strong })
        .when(on, Styled::justify_end)
        .child(div().size(px(18.)).rounded_full().bg(if on { theme.lumen_ink } else { theme.text }))
}

/// A line through `samples`, scaled to the largest.
#[expect(clippy::cast_precision_loss, reason = "a few dozen samples")]
pub fn sparkline(samples: Vec<f32>, color: Hsla, width: f32, height: f32) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, (), window, _| {
            if samples.len() < 2 {
                return;
            }
            let max = samples.iter().copied().fold(1.0_f32, f32::max);
            let step = bounds.size.width / (samples.len() - 1) as f32;
            let inner = bounds.size.height - px(2.);
            let mut path = PathBuilder::stroke(px(1.5));
            for (i, sample) in samples.iter().enumerate() {
                let at = point(
                    bounds.left() + step * i as f32,
                    bounds.bottom() - px(1.) - inner * (sample / max),
                );
                if i == 0 {
                    path.move_to(at);
                } else {
                    path.line_to(at);
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        },
    )
    .w(px(width))
    .h(px(height))
}
