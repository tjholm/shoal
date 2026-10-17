//! The little that differs between macOS and Windows.

use gpui::App;

/// The app lives in the menu bar, not the Dock. Call at the start of
/// `Application::run`: GPUI sets the regular Dock policy just before it.
pub fn hide_from_dock() {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
        let main_thread = objc2::MainThreadMarker::new().expect("called on the main thread");
        NSApplication::sharedApplication(main_thread)
            .setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    }
}

/// Keeps the app running with no windows open. GPUI on Windows quits when
/// its last window closes, so an invisible window is kept open there.
pub fn keep_alive_without_windows(cx: &mut App) {
    #[cfg(windows)]
    {
        let options = gpui::WindowOptions {
            show: false,
            focus: false,
            kind: gpui::WindowKind::PopUp,
            ..Default::default()
        };
        if let Err(error) = cx.open_window(options, |_, cx| cx.new(|_| gpui::Empty)) {
            tracing::error!("couldn't open the keep-alive window: {error}");
        }
    }
    #[cfg(not(windows))]
    let _ = cx;
}
