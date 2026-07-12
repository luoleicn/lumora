#!/usr/bin/env bash
# One-time script: generate a .DS_Store template for lumora DMG layout.
#
# Run this once, then commit apps/desktop/src-tauri/dmg-dsstore to the repo.
# After that, release-macos.sh will use the template instead of mounting
# and configuring the DMG window each time.
#
# Usage:
#   ./scripts/generate-dmg-dsstore.sh
#
# What it does:
#   1. Creates a throwaway DMG with the app and /Applications symlink
#   2. Mounts it and configures the Finder window via AppleScript
#   3. Copies the resulting .DS_Store to the project
#   4. Cleans up

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="lumora"
TMP_DIR="$PROJECT_DIR/.dsstore-tmp"
TMP_DMG="$TMP_DIR/tmp.dmg"
STAGING="$TMP_DIR/staging"
OUTPUT="$PROJECT_DIR/apps/desktop/src-tauri/dmg-dsstore"

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[generate-dsstore]${NC} $1"; }

# --------------- cleanup ---------------

cleanup() {
  # Detach any leftover mount
  if [[ -d "$TMP_DIR" ]]; then
    hdiutil detach "/Volumes/$APP_NAME" -force >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$STAGING"

# --------------- build staging ---------------

# We need a real .app bundle. If the user hasn't built yet, look for an
# existing one. We only need it so Finder can render its icon — the actual
# binary doesn't matter for .DS_Store generation.
APP_SRC="$PROJECT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$APP_SRC" ]]; then
  APP_SRC="$PROJECT_DIR/apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app"
fi
if [[ ! -d "$APP_SRC" ]]; then
  echo "ERROR: No .app bundle found. Build the project first with:" >&2
  echo "  npm run tauri:build --workspace @lumora/desktop" >&2
  exit 1
fi
log "Using app bundle: $APP_SRC"

cp -R "$APP_SRC" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

# Copy background image if available
BG_SRC="$PROJECT_DIR/apps/desktop/src-tauri/dmg-background.png"
if [[ -f "$BG_SRC" ]]; then
  cp "$BG_SRC" "$STAGING/.background.png"
  log "Background image copied."
fi

# --------------- create & mount DMG ---------------

log "Creating temporary DMG..."
hdiutil create -srcfolder "$STAGING" \
  -volname "$APP_NAME" \
  -format UDRW \
  -size 200m \
  -ov \
  "$TMP_DMG" >/dev/null

log "Mounting..."
hdiutil attach "$TMP_DMG" >/dev/null
sleep 2

# --------------- configure Finder window ---------------

log "Configuring Finder window layout..."

osascript - "$APP_NAME" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  tell application "Finder"
    activate
    tell disk appName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {400, 200, 1000, 660}
      set viewOptions to the icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 72
      set position of item (appName & ".app") to {160, 210}
      set position of item "Applications" to {440, 210}

      -- If a background image exists, apply it
      try
        set background picture of viewOptions to file ".background.png" of targetDisk
      end try

      update without registering applications
      delay 1
      close
    end tell
  end tell
end run
APPLESCRIPT

sleep 2

# --------------- copy .DS_Store ---------------

log "Copying .DS_Store..."
cp "/Volumes/$APP_NAME/.DS_Store" "$OUTPUT"

log "Template saved to: $OUTPUT"

# --------------- cleanup (via trap) ---------------

hdiutil detach "/Volumes/$APP_NAME" -force >/dev/null
sleep 1

log "Done. You can now commit $OUTPUT to the repo."
