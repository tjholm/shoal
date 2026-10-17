//! The window. Everything here reads from and acts through the
//! [`Controller`](crate::controller::Controller); none of it touches the
//! worker directly.

pub mod format;
mod text_field;
mod theme;
mod window;

pub use window::{MainWindow, open};

pub fn bind_keys(cx: &mut gpui::App) {
    text_field::bind_keys(cx);
    window::bind_keys(cx);
}
