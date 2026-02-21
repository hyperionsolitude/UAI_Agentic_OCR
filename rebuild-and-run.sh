#!/usr/bin/env bash
# Rebuild and run Agentic OCR GPT. Builds .app + DMG, then launches the .app (no DMG popup, no waiting).
# Usage: ./rebuild-and-run.sh   (or: bash rebuild-and-run.sh)

set -e
cd "$(dirname "$0")"

# Ensure Rust is on PATH (common when installed via rustup)
export PATH="${HOME}/.cargo/bin:${PATH}"
unset CI

echo "Building Tauri app (app bundle + DMG; frontend is built by Tauri's beforeBuildCommand)..."
npx tauri build

APP_PATH="src-tauri/target/release/bundle/macos/Agentic OCR GPT.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: App not found at $APP_PATH" >&2
  exit 1
fi

echo "Launching app..."
open "$APP_PATH"

echo "Done."
