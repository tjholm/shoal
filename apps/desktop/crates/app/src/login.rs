//! Launch at login: a launch agent on macOS, the per-user Run key on Windows.
//! The OS is the source of truth, so nothing is saved in the settings.

use auto_launch::{AutoLaunch, AutoLaunchBuilder, MacOSLaunchMode, WindowsEnableMode};

fn launcher() -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    // The Run key holds a command line, so a path with spaces must be quoted.
    let path =
        if cfg!(windows) { format!("\"{}\"", exe.display()) } else { exe.display().to_string() };
    AutoLaunchBuilder::new()
        .set_app_name("Shoal")
        .set_app_path(&path)
        .set_macos_launch_mode(MacOSLaunchMode::LaunchAgent)
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .build()
        .map_err(|error| error.to_string())
}

pub fn is_enabled() -> bool {
    launcher().and_then(|l| l.is_enabled().map_err(|e| e.to_string())).unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let launcher = launcher()?;
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|error| format!("Couldn't change launch at login: {error}"))
}
