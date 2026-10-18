# Desktop app memory spike

How much memory does each desktop stack use, measured on the same Linux machine?
Run on 2026-10-19: NixOS, Hyprland (Wayland), Intel integrated GPU (`xe`),
WebKitGTK 2.54, Deno 2.9.7, Electrobun 2.0.2, Electron 43.7.7 (nixpkgs), GPUI 0.2.2.

## Results

Median of 3 runs, in MiB, sampled for 10 s after a 20 s settle. Each number
covers every process in the app's session, so webview and network helpers are
included.

| App | PSS | USS | RSS | GPU | PSS + GPU |
|---|---:|---:|---:|---:|---:|
| Rust PR #27 (GPUI), setup window | 47 | 44 | 79 | 108 | 155 |
| Electrobun on Bun, shell, tray only | 59 | 57 | 108 | 0 | 59 |
| Electrobun on Bun, shell, window | 143 | 118 | 448 | 71 | 214 |
| Deno desktop, shell, window | 148 | 125 | 443 | 138 | 286 |
| Deno desktop, shell, window hidden | 146 | 124 | 441 | 113 | 260 |
| Electrobun PoC (`desktop-app`), setup window | 251 | 198 | 489 | 126 | 378 |
| Electrobun on Cottontail, shell, tray only | 382 | 380 | 431 | 0 | 382 |
| Electron, shell, tray only | 193 | 117 | 481 | 22 | 215 |
| Electron, shell, window | 406 | 264 | 853 | 60 | 466 |
| Electrobun on Cottontail, shell, window | 475 | 450 | 777 | 71 | 546 |

- **PSS** is the fairest single number: memory shared between processes (such as WebKit's libraries) is split between them, not counted again for each one.
- **GPU** is resident GPU buffer memory from DRM fdinfo. On an integrated GPU it comes out of system RAM, but PSS doesn't include it.
- **The shells** are identical across frameworks: a tray icon with a two-item menu, and a window showing the static Overview board from the design artifact. In tray-only mode the window is never created. Deno has no way to start without its window, so it creates the window and hides it.
- **The real apps** ran as fresh installs (throwaway `HOME` and XDG dirs), so both show their first-run setup screen and neither connects to a server.

## Findings

- **The Rust app is the lightest with a window open:** 47 MiB PSS, or 155 MiB counting the GPU. Its 79 MiB RSS matches PR #27's "about 80 MB" claim, which was measured on macOS. That claim doesn't count the 108 MiB GPUI holds on the GPU here.
- **Electrobun on Bun with no window uses 59 MiB,** the state a tray app spends most of its life in. The Rust app wasn't measured with its window closed, so the two can't yet be compared at rest. With the window open Electrobun on Bun uses 143 MiB, and most of that is WebKit (about 97 MiB for the web process, 24 MiB for the network process).
- **Cottontail, Electrobun's default main process, costs about 320 MiB more than Bun,** with or without a window. Nearly all of it is anonymous memory inside the Cottontail process. It holds steady at about 435 MiB and doesn't grow, so it's not a leak.
- **Deno desktop is no lighter than Electrobun on Bun with a window,** uses more GPU memory, and can't drop its webview by hiding the window. It's also experimental (canary only since 2.9).
- **The PoC costs about 108 MiB more than the Bun shell with a window open.** That splits as about 90 MiB in the Bun main process (Effect plus the worker) and about 18 MiB in the webview (React, Tailwind and fonts rather than static HTML).
- **Electron is the heaviest stack apart from Cottontail:** 406 MiB with the window open (about 2.8× Electrobun on Bun and 8.6× Rust), and 193 MiB with no window (about 3.3× Electrobun on Bun). Even with no window it runs six processes.

## Full Electrobun app vs the Rust app

The `desktop-full` branch rebuilds PR #27's features on Electrobun with Bun as
the main process. Both apps ran as fresh installs on their first-run screen,
3 runs each (`results-full.jsonl`).

| App | PSS | GPU | PSS + GPU |
|---|---:|---:|---:|
| Rust PR #27, setup window | 47 | 116 | 163 |
| Electrobun full, setup window | 259 | 66 | 325 |
| Electrobun full, window closed | 156 | 13 | 169 |

- **Closing the window frees the webview.** WebKit's web process exits and only its network process (about 28 MiB) stays.
- **The Rust app couldn't be measured with its window closed.** On Linux it quits when its last window closes; it only stays in the tray on macOS and Windows. With the window closed it would use at most the 47 MiB it uses with the window open.
- **Most of the gap at rest is Electrobun's Bun main process,** about 125 MiB. Effect and the worker run there, the same code the CLI runs.
- **Code to maintain:** about 1,700 lines of desktop app plus about 590 net lines in the shared core, against about 7,000 hand-written lines in PR #27. That 7,000 includes its 37 tests, which the Electrobun branch doesn't have, and a second copy of the worker.

## Connected to a shoal server

The Electrobun app configured against a local dev server, the llama-swap
backend and one concurrent job, in fresh config dirs, 3 runs each
(`results-connected.jsonl`). A configured app opens no window, so this is the
state it spends most of its time in. "Under load" streams the same chat
request through the server back to back while measuring.

| App | Idle PSS | Under load PSS | GPU |
|---|---:|---:|---:|
| Electrobun full | 97 | 105 | 0 |

- **At rest the app is one Bun process.** WebKit starts only when the window opens.
- **The Rust app's connected runs are missing.** It couldn't verify the dev server's certificate in those runs, so it never connected, and its numbers were dropped. It needs a rerun.

## Not measured

- The Rust app with its window closed.
- The PoC after its window has been opened and closed. WebKitGTK may keep its web process alive, so it's unclear whether the PoC falls back to the tray-only figure.
- Any app under load. The worker was idle, with no jobs or backends.
- macOS. WKWebView is generally lighter than WebKitGTK, and Activity Monitor's figure isn't PSS.

Getting PR #27 to keep a token on Linux also needed the Secret Service
keyring backend (`patches/pr27-linux.patch`). On NixOS, Electrobun's Bun needs
`libsecret` on the nix-ld path for `Bun.secrets`, added to `desktop-full`'s
flake.

## Reproduce

```sh
git worktree add ../shoal-poc desktop-app
git fetch origin pull/27/head:pr-27-desktop && git worktree add ../shoal-pr27 pr-27-desktop
# Apply patches/pr27-linux.patch in ../shoal-pr27 (PR #27 doesn't build on Linux otherwise).
nix develop ../shoal-poc -c ./spikes/desktop-memory/build.sh
nix develop ../shoal-poc -c ./spikes/desktop-memory/run.sh
```

For the connected runs, save the worker API key in the keyring for both apps
(`Bun.secrets` service `school.shoal.worker` named after the server origin;
`secret-tool store service io.shoal.desktop username wss://<host>/ws/workers`
for the Rust app), set the variables listed at the top of `connected.sh`, and
run it once per app and scenario. `load.sh` is the load it starts.

`measure.py` launches one app and prints a JSON line with the totals and a per-process breakdown.
