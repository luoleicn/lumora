#!/usr/bin/env bash
# Release lumora macOS build to GitHub Releases.
#
# Usage:
#   ./scripts/release-macos.sh --tag v0.1.0 [--draft]
#
#   --tag is required. The tag must be new (must not already exist locally or on
#   the remote). This enforces a clean one-tag-per-release workflow.
#
# Prerequisites:
#   - Rust stable toolchain
#   - Node.js 22+, npm 11+
#   - GitHub CLI (`brew install gh`) and logged in (`gh auth login`)
#     OR set GITHUB_TOKEN env var for API fallback.
#
# What it does:
#   1. Validates that --tag was given and that it doesn't already exist
#   2. Installs the Rust cross-compilation target for the "other" arch
#   3. Runs `npm run tauri:build` to produce the native .app bundle
#   4. Cross-compiles the Rust binary for the other architecture
#   5. Merges both binaries with `lipo` into a universal binary, then re-signs the .app
#   6. Packages the universal .app into a .zip and a .dmg
#   7. Pushes the new git tag
#   8. Creates a GitHub Release and uploads the artifacts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="lumora"
TAURI_DIR="$PROJECT_DIR/apps/desktop/src-tauri"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle/macos"
APP_BUNDLE="$BUNDLE_DIR/$APP_NAME.app"
CONFIG_FILE="$TAURI_DIR/tauri.conf.json"

# --------------- helpers ---------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[release]${NC} $1"; }
warn() { echo -e "${YELLOW}[release] WARN:${NC} $1"; }
err()  { echo -e "${RED}[release] ERROR:${NC} $1" >&2; exit 1; }

# --------------- parse args ---------------

DRAFT=false
TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) DRAFT=true; shift ;;
    --tag)   TAG="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --tag vX.Y.Z [--draft]"
      echo ""
      echo "  --tag    (required) New version tag, e.g. v0.2.0. Must not already exist."
      echo "  --draft  Create the release as a draft (not publicly visible)."
      exit 0
      ;;
    *) err "Unknown option: $1" ;;
  esac
done

# --------------- validate tag ---------------

if [[ -z "$TAG" ]]; then
  err "--tag is required. Usage: $0 --tag vX.Y.Z [--draft]"
fi

# Sanity-check tag format
if ! echo "$TAG" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  err "Tag '$TAG' doesn't look like a version tag (expected vX.Y.Z or vX.Y.Z-prerelease)."
fi

VERSION="${TAG#v}"
log "App: $APP_NAME  Version: $VERSION  Tag: $TAG"
log "Project: $PROJECT_DIR"

# --------------- check prerequisites ---------------

command -v npm   >/dev/null 2>&1 || err "npm is required (Node.js 22+)"
command -v cargo >/dev/null 2>&1 || err "cargo is required (Rust stable toolchain)"

if command -v gh >/dev/null 2>&1; then
  USE_GH_CLI=true
  log "Using GitHub CLI for release management."
  if ! gh auth status >/dev/null 2>&1; then
    err "gh is not authenticated. Run: gh auth login"
  fi
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  USE_GH_CLI=false
  log "Using GITHUB_TOKEN for API fallback."
else
  err "Neither 'gh' CLI nor GITHUB_TOKEN env var found.\n  Install gh: brew install gh && gh auth login\n  Or: export GITHUB_TOKEN=<your-token>"
fi

# Extract GitHub owner/repo from git remote
REPO_URL=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null) \
  || err "No 'origin' remote found. Run this from within the lumora repo."
REPO_SLUG=$(echo "$REPO_URL" | sed -E 's|.*[:/]([^/]+/[^/]+)(\.git)?$|\1|')
log "Target repo: $REPO_SLUG"

# --------------- ensure tag is new ---------------

# Check local tags
if git -C "$PROJECT_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
  err "Tag '$TAG' already exists locally. Use a new tag."
fi

# Check remote tags (fetch first to be sure)
log "Fetching remote tags..."
git -C "$PROJECT_DIR" fetch origin --tags --quiet 2>/dev/null || true
if git -C "$PROJECT_DIR" ls-remote --tags origin "$TAG" 2>/dev/null | grep -q "$TAG"; then
  err "Tag '$TAG' already exists on origin. Use a new tag."
fi

# Check that a GitHub Release for this tag doesn't already exist
if [[ "$USE_GH_CLI" == "true" ]]; then
  if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    err "GitHub Release for '$TAG' already exists. Use a new tag."
  fi
else
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO_SLUG/releases/tags/$TAG")
  if [[ "$HTTP_CODE" == "200" ]]; then
    err "GitHub Release for '$TAG' already exists. Use a new tag."
  fi
fi

log "Tag '$TAG' is available -- proceeding."

# --------------- build for both architectures ---------------

# Targets to build
ARM_TARGET="aarch64-apple-darwin"
INTEL_TARGET="x86_64-apple-darwin"

# Install any missing Rust targets
for target in "$ARM_TARGET" "$INTEL_TARGET"; do
  if ! rustup target list --installed 2>/dev/null | grep -q "$target"; then
    log "Installing Rust target: $target ..."
    rustup target add "$target"
  fi
done

# Build for Apple Silicon
log "Building for Apple Silicon ($ARM_TARGET)..."
cd "$PROJECT_DIR"
npm run tauri:build --workspace @lumora/desktop -- --target "$ARM_TARGET"

ARM_APP="$TAURI_DIR/target/$ARM_TARGET/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$ARM_APP" ]]; then
  err "ARM build did not produce $ARM_APP"
fi
log "ARM build: $(file -b "$ARM_APP/Contents/MacOS/$APP_NAME")"

# Build for Intel
log "Building for Intel ($INTEL_TARGET)..."
npm run tauri:build --workspace @lumora/desktop -- --target "$INTEL_TARGET"

INTEL_APP="$TAURI_DIR/target/$INTEL_TARGET/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$INTEL_APP" ]]; then
  err "Intel build did not produce $INTEL_APP"
fi
log "Intel build: $(file -b "$INTEL_APP/Contents/MacOS/$APP_NAME")"

# --------------- package DMGs ---------------

ARTIFACTS_DIR="$PROJECT_DIR/.release-artifacts"
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

ARM_DMG_NAME="${APP_NAME}-${TAG}-macos-arm64.dmg"
ARM_DMG_PATH="$ARTIFACTS_DIR/$ARM_DMG_NAME"
INTEL_DMG_NAME="${APP_NAME}-${TAG}-macos-x64.dmg"
INTEL_DMG_PATH="$ARTIFACTS_DIR/$INTEL_DMG_NAME"

make_dmg() {
  local app_bundle="$1"
  local dmg_path="$2"
  local dmg_name
  dmg_name=$(basename "$dmg_path")

  log "Creating DMG: $dmg_name ..."

  local tmp_dmg="${ARTIFACTS_DIR}/.tmp_$(basename "$dmg_path" .dmg).dmg"
  rm -f "$tmp_dmg"

  local app_size_kb
  app_size_kb=$(du -sk "$app_bundle" | awk '{print $1}')
  local dmg_size_mb=$(( (app_size_kb / 1024) + 30 ))

  hdiutil create -size ${dmg_size_mb}m -fs HFS+ -volname "$APP_NAME" -layout NONE "$tmp_dmg" >/dev/null
  hdiutil attach "$tmp_dmg" -noautoopen -nobrowse -mountpoint "$ARTIFACTS_DIR/.mnt" >/dev/null

  cp -R "$app_bundle" "$ARTIFACTS_DIR/.mnt/"
  ln -s /Applications "$ARTIFACTS_DIR/.mnt/Applications"

  sleep 2
  local dev
  dev=$(hdiutil info | awk -v mp="$ARTIFACTS_DIR/.mnt" '$0 ~ mp {for(i=1;i<=NF;i++) if($i ~ /^\/dev\//) {print $i; exit}}')
  hdiutil detach "$dev" -force >/dev/null 2>&1 || true

  hdiutil convert "$tmp_dmg" -format UDZO -imagekey zlib-level=9 -o "$dmg_path" >/dev/null
  rm -f "$tmp_dmg"

  log "  DMG: $dmg_path ($(du -sh "$dmg_path" | awk '{print $1}'))"
}

make_dmg "$ARM_APP" "$ARM_DMG_PATH"
make_dmg "$INTEL_APP" "$INTEL_DMG_PATH"

# --------------- push tag ---------------

log "Creating git tag: $TAG"
git -C "$PROJECT_DIR" tag -a "$TAG" -m "Release $TAG"
git -C "$PROJECT_DIR" push origin "$TAG"
log "Tag $TAG pushed."

# --------------- GitHub Release ---------------

RELEASE_NOTES="## lumora $TAG

macOS desktop build — separate DMGs for Apple Silicon and Intel Macs.

### Download
- **$ARM_DMG_NAME** — for Apple Silicon (M1/M2/M3/M4)
- **$INTEL_DMG_NAME** — for Intel Macs

### Notes
- Requires macOS 10.13 (High Sierra) or later.
- Built from $(git -C "$PROJECT_DIR" rev-parse --short HEAD).
"

ASSETS=("$ARM_DMG_PATH" "$INTEL_DMG_PATH")

if [[ "$USE_GH_CLI" == "true" ]]; then
  DRAFT_FLAG=""
  if [[ "$DRAFT" == "true" ]]; then
    DRAFT_FLAG="--draft"
  fi

  log "Creating GitHub Release: $TAG ..."
  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$REPO_SLUG" \
    --title "$APP_NAME $TAG" \
    --notes "$RELEASE_NOTES" \
    $DRAFT_FLAG
else
  API_BASE="https://api.github.com/repos/$REPO_SLUG"
  AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"

  DRAFT_BOOL="false"
  if [[ "$DRAFT" == "true" ]]; then
    DRAFT_BOOL="true"
  fi

  log "Creating GitHub Release via API: $TAG ..."
  RELEASE_BODY=$(python3 -c "
import json
print(json.dumps({
  'tag_name': '$TAG',
  'name': '$APP_NAME $TAG',
  'body': '''$RELEASE_NOTES''',
  'draft': $DRAFT_BOOL,
  'prerelease': False
}))
")
  CREATE_RESP=$(curl -s -X POST \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$RELEASE_BODY" \
    "$API_BASE/releases")
  RELEASE_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

  if [[ -z "$RELEASE_ID" ]] || [[ "$RELEASE_ID" == "null" ]]; then
    echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['message'])" 2>/dev/null || echo "$CREATE_RESP"
    err "Failed to create GitHub Release."
  fi

  for ASSET in "${ASSETS[@]}"; do
    ASSET_NAME=$(basename "$ASSET")
    log "Uploading $ASSET_NAME ..."
    curl -s --fail -X POST \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$ASSET" \
      "$API_BASE/releases/$RELEASE_ID/assets?name=$ASSET_NAME" >/dev/null \
      || err "Failed to upload $ASSET_NAME"
  done
fi

# --------------- done ---------------

log ""
log "${BOLD}Release $TAG complete!${NC}"
log "  Release URL: https://github.com/$REPO_SLUG/releases/tag/$TAG"
log ""
log "Artifacts:"
log "  $ARM_DMG_PATH  (Apple Silicon)"
log "  $INTEL_DMG_PATH  (Intel)"
