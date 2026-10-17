//! The menu-bar (macOS) or notification-area (Windows) icon and its menu.

use std::time::Duration;

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const ACCEPT: &str = "accept";
const OPEN: &str = "open";
const QUIT: &str = "quit";
const PAUSE: &str = "pause:";
const PAUSES: [(&str, u64); 5] =
    [("10 minutes", 10), ("30 minutes", 30), ("1 hour", 60), ("3 hours", 180), ("8 hours", 480)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Accept(bool),
    PauseFor(Duration),
    Open,
    Quit,
}

pub struct Tray {
    icon: TrayIcon,
    status: MenuItem,
    accept: CheckMenuItem,
    shown: Option<(String, bool)>,
}

impl Tray {
    /// On macOS, call only once the app has finished launching.
    pub fn new() -> Result<Self, String> {
        let status = MenuItem::new("Starting…", false, None);
        let accept = CheckMenuItem::with_id(ACCEPT, "Accept work", true, true, None);
        let pauses: Vec<MenuItem> = PAUSES
            .iter()
            .map(|(label, minutes)| {
                MenuItem::with_id(format!("{PAUSE}{minutes}"), label, true, None)
            })
            .collect();
        let pause_items: Vec<&dyn tray_icon::menu::IsMenuItem> =
            pauses.iter().map(|item| item as &dyn tray_icon::menu::IsMenuItem).collect();
        let error = |error: tray_icon::menu::Error| error.to_string();
        let pause = Submenu::with_items("Pause for", true, &pause_items).map_err(error)?;
        let menu = Menu::with_items(&[
            &status,
            &PredefinedMenuItem::separator(),
            &accept,
            &pause,
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id(OPEN, "Open Shoal…", true, None),
            &MenuItem::with_id(QUIT, "Quit Shoal", true, None),
        ])
        .map_err(error)?;

        let builder = TrayIconBuilder::new().with_menu(Box::new(menu)).with_tooltip("Shoal");
        // A template image is tinted by macOS to suit the menu bar.
        #[cfg(target_os = "macos")]
        let builder = builder.with_icon_templated(glyph(true));
        #[cfg(not(target_os = "macos"))]
        let builder = builder.with_icon(glyph(true));
        let icon = builder.build().map_err(|error| error.to_string())?;
        Ok(Self { icon, status, accept, shown: None })
    }

    pub fn show(&mut self, status: &str, accepting: bool) {
        if self.shown.as_ref().is_some_and(|(s, a)| s == status && *a == accepting) {
            return;
        }
        self.status.set_text(status);
        self.accept.set_checked(accepting);
        if self.shown.as_ref().is_none_or(|(_, a)| *a != accepting) {
            #[cfg(target_os = "macos")]
            let _ = self.icon.set_icon_templated(Some(glyph(accepting)));
            #[cfg(not(target_os = "macos"))]
            let _ = self.icon.set_icon(Some(glyph(accepting)));
        }
        let _ = self.icon.set_tooltip(Some(format!("Shoal: {status}")));
        self.shown = Some((status.to_owned(), accepting));
    }

    pub fn command(&self, event: &MenuEvent) -> Option<Command> {
        match event.id.as_ref() {
            // The menu has already toggled the check mark.
            ACCEPT => Some(Command::Accept(self.accept.is_checked())),
            OPEN => Some(Command::Open),
            QUIT => Some(Command::Quit),
            id => {
                let minutes: u64 = id.strip_prefix(PAUSE)?.parse().ok()?;
                Some(Command::PauseFor(Duration::from_secs(minutes * 60)))
            }
        }
    }
}

/// A ring, with a dot in it while accepting work. Drawn at 2x for Retina.
/// Black for macOS to tint as a template; white for Windows' dark taskbar.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "alpha is clamped to 0..=255"
)]
fn glyph(accepting: bool) -> Icon {
    const SIZE: u16 = 36;
    let centre = f32::from(SIZE) / 2.0;
    // How much of a pixel at distance `d` lies between the two radii.
    let coverage = |d: f32, inner: f32, outer: f32| {
        (d - inner + 0.5).clamp(0.0, 1.0).min((outer - d + 0.5).clamp(0.0, 1.0))
    };
    let ink = if cfg!(target_os = "macos") { 0 } else { 255 };
    let mut rgba = Vec::with_capacity(usize::from(SIZE) * usize::from(SIZE) * 4);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = (f32::from(x) + 0.5 - centre).hypot(f32::from(y) + 0.5 - centre);
            let ring = coverage(d, 11.5, 15.5);
            let dot = if accepting { coverage(d, -1.0, 6.5) } else { 0.0 };
            rgba.extend_from_slice(&[ink, ink, ink, (ring.max(dot) * 255.0).round() as u8]);
        }
    }
    Icon::from_rgba(rgba, u32::from(SIZE), u32::from(SIZE)).expect("a valid icon")
}
