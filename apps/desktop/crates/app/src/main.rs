//! Shoal for the desktop: a menu-bar app that runs a shoal worker.
//!
//! Layers, each depending only on those below it:
//! - `ui` and `tray`: what the user sees, driven by the controller;
//! - `controller`: the app's model, owning the worker and settings;
//! - `shoal-worker`: the worker itself, with no UI dependencies.

#![cfg_attr(windows, windows_subsystem = "windows")]

mod controller;
mod keychain;
mod logging;
mod login;
mod platform;
mod settings;
mod tray;
mod ui;

use std::fs::{self, File, OpenOptions, TryLockError};
use std::time::Duration;

use gpui::{App, AppContext as _, Application, Entity, Global, WindowHandle};
use shoal_worker::Availability;
use tray_icon::menu::MenuEvent;

use controller::Controller;
use tray::{Command, Tray, View};
use ui::MainWindow;

/// State that lives as long as the app.
struct Shell {
    controller: Entity<Controller>,
    tray: Tray,
    window: Option<WindowHandle<MainWindow>>,
    /// Setup is offered once per launch.
    offered_setup: bool,
}

impl Global for Shell {}

fn main() {
    logging::init();
    let Ok(_instance) = lock_instance() else {
        tracing::info!("Shoal is already running");
        return;
    };
    if let Err(error) = keychain::init() {
        tracing::error!("the keychain is unavailable: {error}");
    }

    Application::new().with_assets(ui::Assets).run(|cx: &mut App| {
        platform::hide_from_dock();
        platform::keep_alive_without_windows(cx);
        ui::init(cx);

        let controller = cx.new(Controller::new);
        let tray = match Tray::new() {
            Ok(tray) => tray,
            Err(error) => {
                tracing::error!("couldn't create the tray icon: {error}");
                cx.quit();
                return;
            }
        };
        cx.set_global(Shell {
            controller: controller.clone(),
            tray,
            window: None,
            offered_setup: false,
        });
        if std::env::args().any(|arg| arg == "--open") {
            show_window(cx);
        }

        cx.observe(&controller, |controller, cx| {
            let (view, needs_setup) = {
                let controller = controller.read(cx);
                (View::of(controller), controller.needs_setup())
            };
            let shell = cx.global_mut::<Shell>();
            shell.tray.show(view);
            // Once the keychain has been read, offer setup if it's needed.
            if needs_setup && !std::mem::replace(&mut shell.offered_setup, true) {
                show_window(cx);
            }
        })
        .detach();

        // Keeps a pause's time left current in the menu.
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(30)).await;
                let shown = cx.update(|cx| {
                    let view = View::of(cx.global::<Shell>().controller.read(cx));
                    cx.global_mut::<Shell>().tray.show(view);
                });
                if shown.is_err() {
                    break;
                }
            }
        })
        .detach();

        // Menu events arrive on the main thread but outside GPUI; queue them
        // for GPUI's executor.
        let (events, received) = async_channel::unbounded();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = events.send_blocking(event);
        }));
        cx.spawn(async move |cx| {
            while let Ok(event) = received.recv().await {
                if cx.update(|cx| on_menu(&event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        cx.on_window_closed(|cx| {
            let open = cx.windows();
            let shell = cx.global_mut::<Shell>();
            if shell.window.is_some_and(|w| !open.iter().any(|o| o.window_id() == w.window_id())) {
                shell.window = None;
            }
        })
        .detach();
    });
}

/// Holds a lock for as long as the app runs, so only one copy connects with
/// the worker identity. `None` if the lock file can't be made at all.
fn lock_instance() -> Result<Option<File>, AlreadyRunning> {
    let Some(path) = dirs::config_dir().map(|dir| dir.join("shoal").join("desktop.lock")) else {
        return Ok(None);
    };
    let file = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| OpenOptions::new().create(true).truncate(false).write(true).open(&path));
    match file {
        Ok(file) => match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(TryLockError::WouldBlock) => Err(AlreadyRunning),
            Err(TryLockError::Error(error)) => {
                tracing::warn!("couldn't lock {}: {error}", path.display());
                Ok(None)
            }
        },
        Err(error) => {
            tracing::warn!("couldn't create {}: {error}", path.display());
            Ok(None)
        }
    }
}

struct AlreadyRunning;

fn on_menu(event: &MenuEvent, cx: &mut App) {
    let Some(command) = cx.global::<Shell>().tray.command(event) else { return };
    let controller = cx.global::<Shell>().controller.clone();
    let update =
        |cx: &mut App, change: &dyn Fn(&mut Controller, &mut gpui::Context<Controller>)| {
            controller.update(cx, |controller, cx| change(controller, cx));
        };
    match command {
        Command::Accept(accept) => update(cx, &|c, cx| {
            c.set_availability(if accept { Availability::On } else { Availability::Off }, cx);
        }),
        Command::PauseFor(duration) => update(cx, &|c, cx| c.pause_for(duration, cx)),
        Command::ExtendPause(duration) => update(cx, &|c, cx| c.extend_pause(duration, cx)),
        Command::Resume => update(cx, &|c, cx| c.set_availability(Availability::On, cx)),
        Command::StayOff => update(cx, &|c, cx| c.set_availability(Availability::Off, cx)),
        Command::Open => show_window(cx),
        Command::OpenDashboard => {
            let url = controller.read(cx).settings().dashboard.clone();
            if !url.is_empty() {
                cx.open_url(&url);
            }
        }
        Command::Quit => cx.quit(),
    }
}

fn show_window(cx: &mut App) {
    let existing = cx.global::<Shell>().window;
    let focused = existing
        .is_some_and(|window| window.update(cx, |_, window, _| window.activate_window()).is_ok());
    if !focused {
        let controller = cx.global::<Shell>().controller.clone();
        let window = ui::open(controller, cx);
        cx.global_mut::<Shell>().window = window;
    }
    // An accessory app isn't brought forward unless asked to be.
    cx.activate(true);
}
