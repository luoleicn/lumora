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
#   - GITHUB_TOKEN env var (GitHub personal access token with repo scope)
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
RELEASE_CONFIG_FILE="$TAURI_DIR/tauri.release.conf.json"

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
BUILD_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) DRAFT=true; shift ;;
    --tag)   TAG="$2"; shift 2 ;;
    --build-only) BUILD_ONLY=true; shift ;;
    --help|-h)
      echo "Usage: $0 --tag vX.Y.Z [--draft] [--build-only]"
      echo ""
      echo "  --tag         (required) New version tag, e.g. v0.2.0."
      echo "  --draft       Create the release as a draft (not publicly visible)."
      echo "  --build-only  Only build and stage the DMGs into .release-artifacts/;"
      echo "                skip all GitHub token/repo/tag checks, tagging and release"
      echo "                creation. Used by CI, where the tag already exists."
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
# --------------- check prerequisites ---------------

command -v python3 >/dev/null 2>&1 || err "python3 is required"
command -v node  >/dev/null 2>&1 || err "node is required (Node.js 22+)"
command -v npm   >/dev/null 2>&1 || err "npm is required (Node.js 22+)"
command -v cargo >/dev/null 2>&1 || err "cargo is required (Rust stable toolchain)"
[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || err "TAURI_SIGNING_PRIVATE_KEY is required for updater artifacts"

log "App: $APP_NAME  Version: $VERSION  Tag: $TAG"
log "Project: $PROJECT_DIR"

node "$PROJECT_DIR/scripts/release-version.mjs" "$TAG" "$RELEASE_CONFIG_FILE" \
  || err "Could not prepare the Tauri release version configuration."
trap 'rm -f "$RELEASE_CONFIG_FILE"' EXIT

# In --build-only mode (used by CI, where the tag already exists) skip every
# GitHub token / repo / tag-existence check; only build and stage the DMGs.
if [[ "$BUILD_ONLY" != true ]]; then

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  err "GITHUB_TOKEN env var is required.\n  Create a token at https://github.com/settings/tokens (repo scope)\n  Then: export GITHUB_TOKEN=<your-token>"
fi
log "Using GITHUB_TOKEN for GitHub API."

# Extract GitHub owner/repo from git remote
REPO_URL=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null) \
  || err "No 'origin' remote found. Run this from within the lumora repo."
REPO_SLUG=$(printf '%s\n' "$REPO_URL" | sed -E \
  -e 's|^[^@]+@github\.com:||' \
  -e 's|^https?://github\.com/||' \
  -e 's|/$||' \
  -e 's|\.git$||')
if ! echo "$REPO_SLUG" | grep -qE '^[^/]+/[^/]+$'; then
  err "Could not parse a GitHub owner/repository from origin: $REPO_URL"
fi
log "Target repo: $REPO_SLUG"

# Validate both the token and its repository selection before doing expensive
# cross-architecture builds. GitHub intentionally returns 404 when a valid
# fine-grained token is not authorized for a private repository.
REPO_HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO_SLUG")
case "$REPO_HTTP_CODE" in
  200) ;;
  401) err "GitHub rejected GITHUB_TOKEN (HTTP 401). The token may be invalid or expired." ;;
  404) err "GitHub repository '$REPO_SLUG' is not visible to this token (HTTP 404). Check the token's resource owner and repository access." ;;
  *) err "GitHub repository access check failed (HTTP $REPO_HTTP_CODE)." ;;
esac
log "GitHub token can access $REPO_SLUG."

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
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO_SLUG/releases/tags/$TAG")
if [[ "$HTTP_CODE" == "200" ]]; then
  err "GitHub Release for '$TAG' already exists. Use a new tag."
elif [[ "$HTTP_CODE" != "404" ]]; then
  err "Could not check whether release '$TAG' exists (HTTP $HTTP_CODE)."
fi

log "Tag '$TAG' is available -- proceeding."

fi  # end: not --build-only (skip GitHub token/repo/tag checks)

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
npm run tauri:build --workspace @lumora/desktop -- \
  --target "$ARM_TARGET" \
  --config "$RELEASE_CONFIG_FILE"

ARM_APP="$TAURI_DIR/target/$ARM_TARGET/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$ARM_APP" ]]; then
  err "ARM build did not produce $ARM_APP"
fi
log "ARM build: $(file -b "$ARM_APP/Contents/MacOS/$APP_NAME")"

ARM_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$ARM_APP/Contents/Info.plist")
[[ "$ARM_VERSION" == "$VERSION" ]] \
  || err "ARM app version '$ARM_VERSION' does not match release version '$VERSION'."
log "ARM app version verified: $ARM_VERSION"

# Build for Intel
log "Building for Intel ($INTEL_TARGET)..."
npm run tauri:build --workspace @lumora/desktop -- \
  --target "$INTEL_TARGET" \
  --config "$RELEASE_CONFIG_FILE"

INTEL_APP="$TAURI_DIR/target/$INTEL_TARGET/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$INTEL_APP" ]]; then
  err "Intel build did not produce $INTEL_APP"
fi
log "Intel build: $(file -b "$INTEL_APP/Contents/MacOS/$APP_NAME")"

INTEL_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INTEL_APP/Contents/Info.plist")
[[ "$INTEL_VERSION" == "$VERSION" ]] \
  || err "Intel app version '$INTEL_VERSION' does not match release version '$VERSION'."
log "Intel app version verified: $INTEL_VERSION"

# --------------- package DMGs ---------------

ARTIFACTS_DIR="$PROJECT_DIR/.release-artifacts"
# Detach any leftover mounts from a previous interrupted run
if [[ -d "$ARTIFACTS_DIR/.mnt" ]]; then
  hdiutil detach "$ARTIFACTS_DIR/.mnt" -force >/dev/null 2>&1 || true
fi
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

  local staging="${ARTIFACTS_DIR}/.staging_${APP_NAME}"
  rm -rf "$staging"
  mkdir -p "$staging"

  cp -R "$app_bundle" "$staging/"
  ln -s /Applications "$staging/Applications"

  # Apply pre-generated .DS_Store for Finder window layout (icon positions,
  # window size, background image, etc.). This avoids mounting the DMG and
  # running AppleScript during every release build.
  # Generate (or regenerate) the template with: ./scripts/generate-dmg-dsstore.sh
  local dsstore_template="$TAURI_DIR/dmg-dsstore"
  if [[ -f "$dsstore_template" ]]; then
    cp "$dsstore_template" "$staging/.DS_Store"
  else
    warn "No dmg-dsstore template found at $dsstore_template"
    warn "DMG will have default Finder layout. Run scripts/generate-dmg-dsstore.sh to fix."
  fi

  # Copy background image if present (referenced by the .DS_Store template)
  local bg_src="$TAURI_DIR/dmg-background.png"
  if [[ -f "$bg_src" ]]; then
    cp "$bg_src" "$staging/.background.png"
  fi

  hdiutil create -srcfolder "$staging" \
    -volname "$APP_NAME" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -ov \
    "$dmg_path" >/dev/null

  rm -rf "$staging"

  log "  DMG: $dmg_path ($(du -sh "$dmg_path" | awk '{print $1}'))"
}

make_dmg "$ARM_APP" "$ARM_DMG_PATH"
make_dmg "$INTEL_APP" "$INTEL_DMG_PATH"

# Tauri's updater bundle is separate from the user-facing DMG. Keep both: the
# DMG is for fresh installs, while the signed app archive is consumed by the
# in-app updater.
ARM_UPDATER_SRC="$TAURI_DIR/target/$ARM_TARGET/release/bundle/macos/$APP_NAME.app.tar.gz"
INTEL_UPDATER_SRC="$TAURI_DIR/target/$INTEL_TARGET/release/bundle/macos/$APP_NAME.app.tar.gz"
[[ -f "$ARM_UPDATER_SRC" && -f "$ARM_UPDATER_SRC.sig" ]] || err "ARM updater archive/signature was not generated"
[[ -f "$INTEL_UPDATER_SRC" && -f "$INTEL_UPDATER_SRC.sig" ]] || err "Intel updater archive/signature was not generated"
ARM_UPDATER_PATH="$ARTIFACTS_DIR/${APP_NAME}-${TAG}-macos-arm64.app.tar.gz"
INTEL_UPDATER_PATH="$ARTIFACTS_DIR/${APP_NAME}-${TAG}-macos-x64.app.tar.gz"
cp "$ARM_UPDATER_SRC" "$ARM_UPDATER_PATH"
cp "$ARM_UPDATER_SRC.sig" "$ARM_UPDATER_PATH.sig"
cp "$INTEL_UPDATER_SRC" "$INTEL_UPDATER_PATH"
cp "$INTEL_UPDATER_SRC.sig" "$INTEL_UPDATER_PATH.sig"

if [[ "$BUILD_ONLY" == true ]]; then
  log ""
  log "${BOLD}Build complete (--build-only).${NC} No tag pushed, no release created."
  log "Artifacts staged in: $ARTIFACTS_DIR"
  log "  $ARM_DMG_PATH  (Apple Silicon)"
  log "  $INTEL_DMG_PATH  (Intel)"
  log "  $ARM_UPDATER_PATH  (signed updater)"
  log "  $INTEL_UPDATER_PATH  (signed updater)"
  exit 0
fi

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

API_BASE="https://api.github.com/repos/$REPO_SLUG"
AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"

DRAFT_BOOL="False"
if [[ "$DRAFT" == "true" ]]; then
  DRAFT_BOOL="True"
fi

log "Creating GitHub Release via API: $TAG ..."

# Build the release JSON via Python. Release notes may contain special
# characters (backticks, single quotes, etc.) so we pass them through the
# environment rather than interpolating into inline Python string literals.
RELEASE_NOTES_JSON="$RELEASE_NOTES"
export RELEASE_NOTES_JSON

RELEASE_BODY=$(python3 -c '
import os, json, sys
body = os.environ.get("RELEASE_NOTES_JSON", "")
print(json.dumps({
    "tag_name": sys.argv[2],
    "name":    sys.argv[1] + " " + sys.argv[2],
    "body":    body,
    "draft":   sys.argv[3] == "True",
    "prerelease": False
}))
' "$APP_NAME" "$TAG" "$DRAFT_BOOL")

CREATE_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "$AUTH_HEADER" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d "$RELEASE_BODY" \
  "$API_BASE/releases")

# Split response body and HTTP status code (last line)
HTTP_CODE=$(echo "$CREATE_RESP" | tail -1)
RESP_BODY=$(echo "$CREATE_RESP" | sed '$d')

if [[ "$HTTP_CODE" != "201" ]]; then
  echo "$RESP_BODY" | python3 -c "
import sys,json
try:
    data = json.load(sys.stdin)
    for err in data.get('errors', []):
        print(f\"  GitHub: {err.get('field','?')}: {err.get('message','')}\")
    msg = data.get('message','')
    if msg:
        print(f'  GitHub: {msg}')
except: pass
" 2>/dev/null
  echo ""
  echo "Raw response:"
  echo "$RESP_BODY"
  err "Failed to create GitHub Release (HTTP $HTTP_CODE)."
fi

RELEASE_ID=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

if [[ -z "$RELEASE_ID" ]] || [[ "$RELEASE_ID" == "null" ]]; then
  echo "$RESP_BODY"
  err "Release created (HTTP 201) but response had no id."
fi

log "Release created — id: $RELEASE_ID"

UPLOAD_BASE="https://uploads.github.com/repos/$REPO_SLUG/releases/$RELEASE_ID/assets"

for ASSET in "${ASSETS[@]}"; do
  ASSET_NAME=$(basename "$ASSET")
  log "Uploading $ASSET_NAME ..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$ASSET" \
    "$UPLOAD_BASE?name=$ASSET_NAME")
  if [[ "$HTTP_CODE" != "201" ]]; then
    err "Failed to upload $ASSET_NAME (HTTP $HTTP_CODE)"
  fi
done

# --------------- done ---------------

log ""
log "${BOLD}Release $TAG complete!${NC}"
log "  Release URL: https://github.com/$REPO_SLUG/releases/tag/$TAG"
log ""
log "Artifacts:"
log "  $ARM_DMG_PATH  (Apple Silicon)"
log "  $INTEL_DMG_PATH  (Intel)"
