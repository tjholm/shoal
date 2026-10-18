#!/usr/bin/env bash
# Usage: connected.sh <electrobun|rust> <label> [load]
# Configures one app in fresh XDG dirs against a shoal server, measures it,
# and appends the result to stdout. Expects:
#   SHOAL_SERVER   https origin of the server, e.g. https://server.shoal.localhost
#   SHOAL_KEY_FILE file holding a worker API key, already saved in the keyring
#                  for both apps (see README)
#   EXTRA_CA       CA certificate the server's TLS chains to (optional)
#   BACKEND, MODEL the model server both apps use and a model it serves
#   ELECTROBUN_APP the full app's built launcher; RUST_LIBS its library path
set -euo pipefail
SPIKE="$(cd "$(dirname "$0")" && pwd)"
APP=$1 LABEL=$2 LOAD=${3:-}
F=$(mktemp -d)
LOAD_PGID=""
trap 'rm -rf "$F"; [ -n "$LOAD_PGID" ] && kill -- -"$LOAD_PGID" 2>/dev/null; true' EXIT
mkdir -p "$F/.config/shoal"
export HOME=$F XDG_CONFIG_HOME=$F/.config XDG_DATA_HOME=$F/.local/share XDG_STATE_HOME=$F/.local/state XDG_CACHE_HOME=$F/.cache
if [ -n "${EXTRA_CA:-}" ]; then
	cat /etc/ssl/certs/ca-certificates.crt "$EXTRA_CA" > "$F/ca-bundle.pem"
	export NODE_EXTRA_CA_CERTS=$EXTRA_CA SSL_CERT_FILE=$F/ca-bundle.pem
fi
# Its own runtime dir keeps the Electrobun single-instance socket per run; the
# display and session bus are pinned to the real ones first.
export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
mkdir -m 700 "$F/run" && export XDG_RUNTIME_DIR=$F/run
# The previous run's app must be fully gone.
while pgrep -f "stable/app/bin/bun|out/rust-pr27" >/dev/null; do sleep 1; done
host=${SHOAL_SERVER#https://}
if [ "$APP" = electrobun ]; then
	printf '{"serverUrl":"%s","backends":["%s"],"name":"spike-electrobun","concurrency":1,"availability":"on"}' "$SHOAL_SERVER" "$BACKEND" > "$F/.config/shoal/worker.json"
	CMD=("$ELECTROBUN_APP")
	# The first launch only unpacks the bundle.
	python3 -I "$SPIKE/measure.py" warmup --settle 10 --samples 1 -- "${CMD[@]}" >/dev/null
	while pgrep -f "stable/app/bin/bun" >/dev/null; do sleep 1; done
else
	printf '{"server":"wss://%s/ws/workers","name":"spike-rust","dashboard":"","backends":["%s"],"concurrency":1,"availability":"on"}' "${host%/}" "$BACKEND" > "$F/.config/shoal/desktop.json"
	CMD=(env LD_LIBRARY_PATH="$RUST_LIBS" "$SPIKE/out/rust-pr27")
fi
if [ -n "$LOAD" ]; then
	setsid "$SPIKE/load.sh" &
	LOAD_PGID=$!
fi
python3 -I "$SPIKE/measure.py" "$LABEL" --settle 30 --samples 10 -- "${CMD[@]}"
