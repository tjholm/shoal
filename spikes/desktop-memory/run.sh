#!/usr/bin/env bash
# Measures every built app (see build.sh) and appends one JSON line per run to $RESULTS.
# Run inside the desktop-app branch's `nix develop` shell, which provides
# WebKitGTK through nix-ld for the webview apps.
set -euo pipefail

SPIKE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$SPIKE/out}"
RESULTS="${RESULTS:-$SPIKE/results.jsonl}"
RUNS="${RUNS:-3}"
# Resolved before HOME changes, and up front so the nix process isn't part of
# a measured session.
rust_libs="$(nix develop "$SPIKE" -c printenv LD_LIBRARY_PATH 2>/dev/null)"
electron="$(nix build --no-link --print-out-paths nixpkgs#electron)/bin/electron"

# The real apps read saved settings and would connect to a live server, so
# every app runs as a fresh install. Settings, identity and Electrobun's
# unpacked bundle follow the XDG variables, not HOME.
FRESH_HOME="$(mktemp -d)"
trap 'rm -rf "$FRESH_HOME"' EXIT
export HOME="$FRESH_HOME"
export XDG_CONFIG_HOME="$FRESH_HOME/.config"
export XDG_DATA_HOME="$FRESH_HOME/.local/share"
export XDG_STATE_HOME="$FRESH_HOME/.local/state"
export XDG_CACHE_HOME="$FRESH_HOME/.cache"

measure() {
	local label=$1
	shift
	for _ in $(seq "$RUNS"); do
		python3 -I "$SPIKE/measure.py" "$label" -- "$@" | tee -a "$RESULTS"
	done
}

electrobun() { echo "$OUT/electrobun-$1/stable-linux-x64/$2/bin/launcher"; }

# Electrobun unpacks its bundle on first launch, and its launcher detaches, so
# the warm-up goes through measure.py, which kills the whole session.
for app in "cottontail ShoalSpike-cottontail" "bun ShoalSpike-bun" "poc Shoal"; do
	set -- $app
	python3 -I "$SPIKE/measure.py" warmup --settle 10 --samples 1 -- "$(electrobun "$1" "$2")" >/dev/null
done

for tray_only in 0 1; do
	suffix=$([ "$tray_only" = 1 ] && echo " (tray only)" || echo "")
	export SPIKE_TRAY_ONLY=$tray_only
	measure "deno shell$suffix" "$OUT/deno/shoal-deno/shoal-deno"
	measure "electrobun cottontail shell$suffix" "$(electrobun cottontail ShoalSpike-cottontail)"
	measure "electrobun bun shell$suffix" "$(electrobun bun ShoalSpike-bun)"
	measure "electron shell$suffix" "$electron" "$SPIKE/electron/main.cjs"
done
unset SPIKE_TRAY_ONLY

measure "electrobun poc (setup window)" "$(electrobun poc Shoal)"
measure "rust pr27 (setup window)" env LD_LIBRARY_PATH="$rust_libs" "$OUT/rust-pr27"
