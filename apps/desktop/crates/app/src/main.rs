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
use std::time::SystemTime;

use gpui::{App, AppContext as _, Application, Entity, Global, WindowHandle};
use shoal_worker::Availability;
use tray_icon::menu::MenuEvent;

use controller::Controller;
use tray::{Command, Tray};
use ui::MainWindow;

/// State that lives as long as the app.
struct Shell {
    controller: Entity<Controller>,
    tray: Tray,
    window: Option<WindowHandle<MainWindow>>,
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

    Application::new().run(|cx: &mut App| {
        platform::hide_from_dock();
        platform::keep_alive_without_windows(cx);
        ui::bind_keys(cx);

        let controller = cx.new(Controller::new);
        let tray = match Tray::new() {
            Ok(tray) => tray,
            Err(error) => {
                tracing::error!("couldn't create the tray icon: {error}");
                cx.quit();
                return;
            }
        };
        let needs_setup = controller.read(cx).settings().server.is_empty();
        cx.set_global(Shell { controller: controller.clone(), tray, window: None });

        cx.observe(&controller, |controller, cx| {
            let (status, accepting) = {
                let controller = controller.read(cx);
                (controller.status().label, controller.accepting())
            };
            cx.global_mut::<Shell>().tray.show(&status, accepting);
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

        if needs_setup {
            show_window(cx);
        }
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
    let set = |availability, cx: &mut App| {
        controller.update(cx, |controller, cx| controller.set_availability(availability, cx));
    };
    match command {
        Command::Accept(accept) => {
            set(if accept { Availability::On } else { Availability::Off }, cx);
        }
        Command::PauseFor(duration) => {
            set(Availability::PausedUntil(SystemTime::now() + duration), cx);
        }
        Command::Open => show_window(cx),
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
