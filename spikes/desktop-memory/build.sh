#!/usr/bin/env bash
# Builds every app the spike measures into $OUT (default: ./out).
# Run inside the desktop-app branch's `nix develop` shell (it provides hutch and the
# Electrobun libraries). The Rust and Deno steps enter this directory's flake.
set -euo pipefail

SPIKE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$SPIKE/out}"
WORK="$(mktemp -d)"
PR27="${PR27:-$SPIKE/../../../shoal-pr27}"
POC="${POC:-$SPIKE/../../../shoal-poc}"
mkdir -p "$OUT"

# Deno and Bun both bundle any node_modules they find above the project, so
# the shells build from a copy outside the repo.
cp -r "$SPIKE/shell" "$SPIKE/deno" "$WORK/"
nix develop "$SPIKE" -c bash -c "cd '$WORK/deno' && deno desktop --allow-read --allow-net --allow-env --include ../shell --output '$OUT/deno/shoal-deno' main.ts"

for main in cottontail bun; do
	rm -rf "$WORK/electrobun"
	cp -r "$SPIKE/electrobun" "$WORK/electrobun"
	cp -r "$SPIKE/shell" "$WORK/electrobun/shell"
	(cd "$WORK/electrobun" && hutch run install && SPIKE_MAIN_PROCESS=$main hutch run build)
	rm -rf "$OUT/electrobun-$main"
	cp -r "$WORK/electrobun/build" "$OUT/electrobun-$main"
done

# PR #27 needs patches/pr27-linux.patch applied to build on Linux.
nix develop "$SPIKE" -c bash -c "cd '$PR27/apps/desktop' && cargo build --release -p shoal-desktop"
cp "$PR27/apps/desktop/target/release/shoal-desktop" "$OUT/rust-pr27"

(cd "$POC/apps/desktop" && hutch run install && hutch run build)
rm -rf "$OUT/electrobun-poc"
cp -r "$POC/apps/desktop/build" "$OUT/electrobun-poc"

rm -rf "$WORK"
