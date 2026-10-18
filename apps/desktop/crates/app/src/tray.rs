//! The menu-bar (macOS) or notification-area (Windows) icon and its menu.

use std::time::{Duration, Instant, SystemTime};

use resvg::{tiny_skia, usvg};
use shoal_worker::{Availability, Connection};
use tray_icon::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::controller::Controller;
use crate::ui::format;

const ACCEPT: &str = "accept";
const RESUME: &str = "resume";
const STAY_OFF: &str = "stay-off";
const OPEN: &str = "open";
const DASHBOARD: &str = "dashboard";
const QUIT: &str = "quit";
const PAUSE: &str = "pause:";
const EXTEND: &str = "extend:";
const PAUSES: [(&str, u64); 5] =
    [("10 minutes", 10), ("30 minutes", 30), ("1 hour", 60), ("3 hours", 180), ("8 hours", 480)];
const EXTENSIONS: [(&str, u64); 3] = [("30 minutes", 30), ("1 hour", 60), ("3 hours", 180)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Accept(bool),
    PauseFor(Duration),
    ExtendPause(Duration),
    Resume,
    StayOff,
    Open,
    OpenDashboard,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Accepting,
    Paused,
    Off,
}

/// What the tray shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub mode: Mode,
    pub status: String,
    pub detail: Option<String>,
    pub dashboard: bool,
}

impl View {
    pub fn of(controller: &Controller) -> Self {
        let state = controller.state();
        let (mode, detail) = match controller.availability() {
            Availability::On => {
                let detail = matches!(state.connection, Connection::Online { .. })
                    .then(|| {
                        let now = Instant::now();
                        let jobs: Vec<String> = state
                            .jobs
                            .iter()
                            .take(2)
                            .map(|job| {
                                match format::rate(job.chunks, now.duration_since(job.started)) {
                                    Some(rate) => format!("{} · {rate}", job.model),
                                    None => job.model.clone(),
                                }
                            })
                            .collect();
                        (!jobs.is_empty()).then(|| jobs.join(", "))
                    })
                    .flatten();
                (Mode::Accepting, detail)
            }
            Availability::PausedUntil(until) => {
                let left = until.duration_since(SystemTime::now()).unwrap_or_default();
                (Mode::Paused, Some(format!("{} left", format::elapsed(left))))
            }
            Availability::Off => (Mode::Off, None),
        };
        Self {
            mode,
            status: controller.status().label,
            detail,
            dashboard: !controller.settings().dashboard.is_empty(),
        }
    }
}

pub struct Tray {
    icon: TrayIcon,
    menu: Option<Built>,
}

/// The current menu, kept to update its text in place.
struct Built {
    shape: (Mode, bool, bool),
    status: MenuItem,
    detail: Option<MenuItem>,
    accept: Option<CheckMenuItem>,
    view: View,
}

impl Tray {
    /// On macOS, call only once the app has finished launching.
    pub fn new() -> Result<Self, String> {
        let builder = TrayIconBuilder::new().with_tooltip("Shoal");
        // A template image is tinted by macOS to suit the menu bar.
        #[cfg(target_os = "macos")]
        let builder = builder.with_icon_templated(glyph(false));
        #[cfg(not(target_os = "macos"))]
        let builder = builder.with_icon(glyph(false));
        let icon = builder.build().map_err(|error| error.to_string())?;
        Ok(Self { icon, menu: None })
    }

    pub fn show(&mut self, view: View) {
        let shape = (view.mode, view.detail.is_some(), view.dashboard);
        match &mut self.menu {
            Some(built) if built.view == view => {}
            Some(built) if built.shape == shape => {
                built.status.set_text(&view.status);
                if let (Some(item), Some(detail)) = (&built.detail, &view.detail) {
                    item.set_text(detail);
                }
                if let Some(accept) = &built.accept {
                    accept.set_checked(view.mode == Mode::Accepting);
                }
                let _ = self.icon.set_tooltip(Some(format!("Shoal: {}", view.status)));
                built.view = view;
            }
            _ => {
                let lit = self.menu.as_ref().map(|built| built.view.mode == Mode::Accepting);
                if lit != Some(view.mode == Mode::Accepting) {
                    #[cfg(target_os = "macos")]
                    let _ = self.icon.set_icon_templated(Some(glyph(view.mode == Mode::Accepting)));
                    #[cfg(not(target_os = "macos"))]
                    let _ = self.icon.set_icon(Some(glyph(view.mode == Mode::Accepting)));
                }
                let _ = self.icon.set_tooltip(Some(format!("Shoal: {}", view.status)));
                match build(view, shape) {
                    Ok((menu, built)) => {
                        self.icon.set_menu(Some(Box::new(menu)));
                        self.menu = Some(built);
                    }
                    Err(error) => tracing::error!("couldn't build the tray menu: {error}"),
                }
            }
        }
    }

    pub fn command(&self, event: &MenuEvent) -> Option<Command> {
        let accept = self.menu.as_ref().and_then(|built| built.accept.as_ref());
        let minutes = |prefix: &str| {
            let minutes: u64 = event.id.as_ref().strip_prefix(prefix)?.parse().ok()?;
            Some(Duration::from_secs(minutes * 60))
        };
        match event.id.as_ref() {
            // The menu has already toggled the check mark.
            ACCEPT => Some(Command::Accept(accept.is_some_and(CheckMenuItem::is_checked))),
            RESUME => Some(Command::Resume),
            STAY_OFF => Some(Command::StayOff),
            OPEN => Some(Command::Open),
            DASHBOARD => Some(Command::OpenDashboard),
            QUIT => Some(Command::Quit),
            _ => minutes(PAUSE)
                .map(Command::PauseFor)
                .or_else(|| minutes(EXTEND).map(Command::ExtendPause)),
        }
    }
}

fn build(view: View, shape: (Mode, bool, bool)) -> Result<(Menu, Built), tray_icon::menu::Error> {
    let menu = Menu::new();
    let status = MenuItem::new(&view.status, false, None);
    menu.append(&status)?;
    let detail = view.detail.as_ref().map(|detail| MenuItem::new(detail, false, None));
    if let Some(detail) = &detail {
        menu.append(detail)?;
    }
    menu.append(&PredefinedMenuItem::separator())?;

    let durations = |prefix: &str, choices: &[(&str, u64)]| -> Vec<MenuItem> {
        choices
            .iter()
            .map(|(label, minutes)| {
                MenuItem::with_id(format!("{prefix}{minutes}"), label, true, None)
            })
            .collect()
    };
    let submenu = |title: &str, items: &[MenuItem]| {
        let items: Vec<&dyn IsMenuItem> =
            items.iter().map(|item| item as &dyn IsMenuItem).collect();
        Submenu::with_items(title, true, &items)
    };
    let mut accept = None;
    match view.mode {
        Mode::Accepting | Mode::Off => {
            let item = CheckMenuItem::with_id(
                ACCEPT,
                "Accept work",
                true,
                view.mode == Mode::Accepting,
                None,
            );
            menu.append(&item)?;
            accept = Some(item);
            if view.mode == Mode::Accepting {
                menu.append(&submenu("Pause for", &durations(PAUSE, &PAUSES))?)?;
            }
        }
        Mode::Paused => {
            menu.append(&MenuItem::with_id(RESUME, "Resume now", true, None))?;
            menu.append(&submenu("Extend pause by", &durations(EXTEND, &EXTENSIONS))?)?;
            menu.append(&MenuItem::with_id(STAY_OFF, "Stay off until I resume", true, None))?;
        }
    }

    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id(OPEN, "Open Shoal…", true, None))?;
    if view.dashboard {
        menu.append(&MenuItem::with_id(DASHBOARD, "Open dashboard", true, None))?;
    }
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id(QUIT, "Quit Shoal", true, None))?;
    Ok((menu, Built { shape, status, detail, accept, view }))
}

/// The shoal glyph, its hub lit while accepting work. Drawn at 2x for
/// Retina: black for macOS to tint as a template, white for Windows' dark
/// taskbar.
fn glyph(lit: bool) -> Icon {
    const SIZE: u32 = 36;
    let ink = if cfg!(target_os = "macos") { "#000" } else { "#fff" };
    let mut svg = include_str!("../assets/glyph-fish.svg")
        .replace("#000", ink)
        // Heavier strokes read better at menu-bar size.
        .replace("stroke-width=\"1.5\"", "stroke-width=\"2\"");
    if lit {
        svg = svg.replace(
            "</svg>",
            &format!("<circle cx=\"12\" cy=\"12\" r=\"2.7\" fill=\"{ink}\"/></svg>"),
        );
    }
    let tree =
        usvg::Tree::from_str(&svg, &usvg::Options::default()).expect("the glyph is valid SVG");
    let mut pixmap = tiny_skia::Pixmap::new(SIZE, SIZE).expect("a non-empty icon");
    #[expect(clippy::cast_precision_loss, reason = "a small constant")]
    let scale = SIZE as f32 / tree.size().width();
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let rgba = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    Icon::from_rgba(rgba, SIZE, SIZE).expect("a valid icon")
}
