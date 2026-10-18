# Shoal desktop

A menu-bar app that runs a shoal worker: a native alternative to `shoal worker start`. It is wire-compatible with the TypeScript worker and shares its stored identity, so a machine keeps the same worker id whichever one runs.

macOS for now; Windows 11 is next.

## Use

```sh
cargo run --release -p shoal-desktop
```

On first launch the window opens for setup:

- **Server:** the worker socket URL, e.g. `wss://shoal.example.com/ws/workers`.
- **Token:** an API key from the shoal dashboard. It is saved to the Keychain (Windows: Credential Manager), never to a file or the shell history.
- **Backends:** comma-separated, tried in order. Ollama, LM Studio, llama.cpp, llama-swap, vLLM and Lemonade are detected automatically.

After that the app lives in the menu bar, as the shoal glyph: its hub is lit while it's accepting work. From the menu you can switch work on or off, pause it for a while, extend a pause, or open the window. Pass `--open` to open the window at launch.

The window has four pages:
- **Overview:** whether work is on, running jobs with live tok/s, and totals since launch.
- **Models:** every model, grouped by backend, with what's loaded.
- **Activity:** the last 50 jobs and how each ended.
- **Settings:** the server, token, backends (with whether each is responding), concurrency, launch at login, and an optional dashboard URL for the menu's "Open dashboard".

Switching off or pausing disconnects at once, abandoning any running jobs.

Logs go to stderr; set `RUST_LOG=debug` for more.

## Layout

Each crate depends only on those above it in this list:

| Crate | Role |
|---|---|
| `crates/protocol` | Wire types, mirroring `packages/protocol` |
| `crates/backends` | Model discovery and job proxying for the OpenAI-compatible backends |
| `crates/worker` | The worker: connection, identity, jobs, availability. No UI dependencies |
| `crates/app` | The GPUI window and tray menu, settings, keychain and launch at login |

[`docs/worker-protocol.md`](docs/worker-protocol.md) specifies the TypeScript worker's behaviour, which the `worker` and `backends` crates follow. Deliberate differences:

- The worker replies `error` to a job it can't read, and to one that panics, rather than leaving the server waiting.
- A `1008 worker already connected` close is retried with backoff, since the server evicts a dropped connection within about 40 s. After about a minute it stops: another worker must be using the identity.
- Other `1008` closes stop the worker until the settings change or work is switched back on, rather than exiting.
- 35 s without a message from the server (it pings every 10 s) counts as a lost connection, so a socket left half-open by sleep or a network change is noticed.
- Backends are probed every 60 s rather than every 10 s while not connected.
- `/v1/models` entries with `null` fields are accepted.
- LM Studio's residency comes from the same `/v1/models` response rather than a second request.
- Malformed chat chunks are logged without their contents.

Logs also go to `~/Library/Logs/Shoal/shoal.log` (Windows: `%LOCALAPPDATA%\shoal\logs`). Only one copy of the app runs at a time.

## Develop

```sh
cargo test
cargo clippy --all-targets
cargo fmt
```

GPUI is built with `runtime_shaders`, so only the Xcode Command Line Tools are needed, not full Xcode.
