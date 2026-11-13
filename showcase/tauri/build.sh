#!/bin/bash
# Syncs the shared web files into dist/, then bundles with the Tauri CLI.
# ./build.sh        release bundle (Roamies.app on macOS, the installer on Windows, .AppImage/.deb/.rpm on Linux)
# ./build.sh dev    debug binary only, faster
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp ../desktop.html dist/
cp -R ../roamies ../onboarding ../panel dist/
../tauri/sidecar/bundle.sh
# Ship a Node.js runtime with the app, for the target being built (--target <triple>, else this machine).
TARGET=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && TARGET="$a"; prev="$a"; done
../tauri/sidecar/fetch-node.sh ${TARGET:+"$TARGET"}
# Windows helpers: voice (Parakeet speech on the PC) and hands (windows, capture, UI Automation, OCR); macOS
# builds its Swift twins in build.rs. Linux has the voice helper only (the same Rust one as Windows).
# Always optimised: a debug voice build is far too slow at reading speech.
TRIPLE="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$TRIPLE" in
  *-windows-*)
    mkdir -p src-tauri/binaries
    for h in voice hands; do
      cargo build --release --locked --manifest-path "src-tauri/$h-win/Cargo.toml" --target "$TRIPLE"
      cp "src-tauri/$h-win/target/$TRIPLE/release/roamies-$h.exe" "src-tauri/binaries/roamies-$h-$TRIPLE.exe"
    done ;;
  # macOS: the same Rust helper as roamies-stt, for Discord calls (Parakeet hears Polish and English; Apple's
  # recogniser doesn't do Polish). ONNX Runtime's prebuilt library wants macOS 13.4+ and clang's runtime linked in.
  *-apple-darwin)
    mkdir -p src-tauri/binaries
    RT="$(clang -print-resource-dir)/lib/darwin/libclang_rt.osx.a"
    RUSTFLAGS="-C link-arg=$RT" MACOSX_DEPLOYMENT_TARGET=14.0 cargo build --release --locked --manifest-path src-tauri/voice-win/Cargo.toml --target "$TRIPLE"
    cp "src-tauri/voice-win/target/$TRIPLE/release/roamies-voice" "src-tauri/binaries/roamies-stt-$TRIPLE" ;;
  *-linux-*)
    mkdir -p src-tauri/binaries
    cargo build --release --locked --manifest-path src-tauri/voice-win/Cargo.toml --target "$TRIPLE"
    cp "src-tauri/voice-win/target/$TRIPLE/release/roamies-voice" "src-tauri/binaries/roamies-voice-$TRIPLE" ;;
esac
cd src-tauri
# macOS signing: APPLE_SIGNING_IDENTITY if set, else the first Developer ID Application certificate in
# the keychain, else ad-hoc. A stable identity keeps macOS permissions across rebuilds.
if [ "$(uname)" = "Darwin" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
fi
# Native Node modules shipped beside the sidecar (Discord voice's encryption) are signed as the app is: the app's
# hardened runtime refuses to load one signed by its author (a different Team ID).
if [ "$(uname)" = "Darwin" ]; then
  find ../sidecar/dist/node_modules -name '*.node' -print0 | while IFS= read -r -d '' f; do
    if [ "$APPLE_SIGNING_IDENTITY" = "-" ]; then codesign --force --sign - "$f"; else codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$f"; fi
  done
fi
# ./build.sh release --target <triple> builds for one target (used by the release workflow).
MODE="${1:-}"; [ $# -gt 0 ] && shift
if [ "$MODE" = "dev" ]; then cargo build; else cargo tauri build ${TAURI_BUNDLES:+--bundles $TAURI_BUNDLES} "$@"; fi
