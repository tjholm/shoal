//! The window. Everything here reads from and acts through the
//! [`Controller`](crate::controller::Controller); none of it touches the
//! worker directly.

mod activity;
mod assets;
pub mod format;
mod models;
mod overview;
mod settings;
mod setup;
mod text_field;
mod theme;
mod widgets;
mod window;

use std::borrow::Cow;

use shoal_worker::{ModelCapability, ModelPurpose, WorkerModel};

pub use assets::Assets;
pub use window::{MainWindow, open};

pub fn init(cx: &mut gpui::App) {
    let fonts = assets::FONTS.iter().map(|font| Cow::Borrowed(*font)).collect();
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        tracing::error!("couldn't load the fonts: {error}");
    }
    text_field::bind_keys(cx);
    window::bind_keys(cx);
}

/// "chat · tools, vision", or "unknown" when the backend can't say.
fn describe(model: &WorkerModel) -> String {
    let purpose = model.purpose.map_or("unknown", |purpose| match purpose {
        ModelPurpose::Chat => "chat",
        ModelPurpose::Embedding => "embedding",
        ModelPurpose::Image => "image",
        ModelPurpose::Tts => "speech",
    });
    let capabilities: Vec<&str> = model
        .capabilities
        .iter()
        .flatten()
        .map(|capability| match capability {
            ModelCapability::Tools => "tools",
            ModelCapability::Vision => "vision",
            ModelCapability::Thinking => "thinking",
        })
        .collect();
    if capabilities.is_empty() {
        purpose.to_owned()
    } else {
        format!("{purpose} · {}", capabilities.join(", "))
    }
}
