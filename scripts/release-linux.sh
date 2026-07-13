#!/usr/bin/env bash
# Release lumora Linux build to GitHub Releases.
#
# Usage:
#   ./scripts/release-linux.sh --tag v0.1.0 [--draft]
#
#   --tag is required. The tag must be new (must not already exist locally or on
#   the remote). This enforces a clean one-tag-per-release workflow.
#
# Prerequisites:
#   - Rust stable toolchain
#   - Node.js 22+, npm 11+
#   - System libs for Tauri/WebKitGTK + packaging (see README "Ubuntu / Debian"):
#       libwebkit2gtk-4.1-dev libgtk-3-dev libsecret-1-dev librsvg2-dev
#       build-essential libssl-dev patchelf file
#   - GITHUB_TOKEN env var (GitHub personal access token with repo scope)
#
# What it does:
#   1. Validates that --tag was given and that it doesn't already exist
#   2. Runs `npm run tauri:build:linux` to produce the native .deb and
#      .AppImage bundles
#   3. Collects the artifacts (renamed with the tag for clarity)
#   4. Pushes the new git tag
#   5. Creates a GitHub Release and uploads the artifacts
#
# This mirrors scripts/release-macos.sh but targets x86_64 Linux (amd64), which
# is the common Ubuntu desktop architecture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="lumora"
TAURI_DIR="$PROJECT_DIR/apps/desktop/src-tauri"
DEB_DIR="$TAURI_DIR/target/release/bundle/deb"
APPIMAGE_DIR="$TAURI_DIR/target/release/bundle/appimage"

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
      echo "  --build-only  Only build and stage artifacts into .release-artifacts/;"
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
log "App: $APP_NAME  Version: $VERSION  Tag: $TAG"
log "Project: $PROJECT_DIR"

# --------------- check prerequisites ---------------

command -v python3 >/dev/null 2>&1 || err "python3 is required"
command -v npm   >/dev/null 2>&1 || err "npm is required (Node.js 22+)"
command -v cargo >/dev/null 2>&1 || err "cargo is required (Rust stable toolchain)"

# In --build-only mode (used by CI, where the tag already exists) skip every
# GitHub token / repo / tag-existence check; only build and stage artifacts.
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

# Validate both the token and its repository selection before doing the
# expensive build. GitHub intentionally returns 404 when a valid fine-grained
# token is not authorized for a private repository.
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

# --------------- build .deb and .AppImage ---------------

log "Building Linux bundles (deb, appimage)..."
cd "$PROJECT_DIR"
npm run tauri:build:linux --workspace @lumora/desktop

# Locate the freshly built artifacts. Tauri names them from the config version,
# e.g. lumora_0.1.0_amd64.deb and lumora_0.1.0_amd64.AppImage.
DEB_SRC=$(ls -t "$DEB_DIR"/*.deb 2>/dev/null | head -1) \
  || err "No .deb found in $DEB_DIR"
APPIMAGE_SRC=$(ls -t "$APPIMAGE_DIR"/*.AppImage 2>/dev/null | head -1) \
  || err "No .AppImage found in $APPIMAGE_DIR"
[[ -f "$DEB_SRC" ]] || err "No .deb found in $DEB_DIR"
[[ -f "$APPIMAGE_SRC" ]] || err "No .AppImage found in $APPIMAGE_DIR"

log "Built deb:      $DEB_SRC ($(du -sh "$DEB_SRC" | awk '{print $1}'))"
log "Built AppImage: $APPIMAGE_SRC ($(du -sh "$APPIMAGE_SRC" | awk '{print $1}'))"

# --------------- stage artifacts with tagged names ---------------

ARTIFACTS_DIR="$PROJECT_DIR/.release-artifacts"
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

DEB_NAME="${APP_NAME}-${TAG}-linux-amd64.deb"
APPIMAGE_NAME="${APP_NAME}-${TAG}-linux-amd64.AppImage"
DEB_PATH="$ARTIFACTS_DIR/$DEB_NAME"
APPIMAGE_PATH="$ARTIFACTS_DIR/$APPIMAGE_NAME"

cp "$DEB_SRC" "$DEB_PATH"
cp "$APPIMAGE_SRC" "$APPIMAGE_PATH"

if [[ "$BUILD_ONLY" == true ]]; then
  log ""
  log "${BOLD}Build complete (--build-only).${NC} No tag pushed, no release created."
  log "Artifacts staged in: $ARTIFACTS_DIR"
  log "  $DEB_PATH"
  log "  $APPIMAGE_PATH"
  exit 0
fi

# --------------- push tag ---------------

log "Creating git tag: $TAG"
git -C "$PROJECT_DIR" tag -a "$TAG" -m "Release $TAG"
git -C "$PROJECT_DIR" push origin "$TAG"
log "Tag $TAG pushed."

# --------------- GitHub Release ---------------

RELEASE_NOTES="## lumora $TAG

Linux desktop build (x86_64 / amd64).

### Download
- **$DEB_NAME** — Debian/Ubuntu package (\`sudo dpkg -i <file>\`)
- **$APPIMAGE_NAME** — portable AppImage (\`chmod +x <file> && ./<file>\`)

### Notes
- Requires a desktop session with WebKitGTK; the \`.deb\` declares its runtime deps.
- Cloud-sync secrets are stored via Secret Service (GNOME Keyring / KWallet).
- Built from $(git -C "$PROJECT_DIR" rev-parse --short HEAD).
"

ASSETS=("$DEB_PATH" "$APPIMAGE_PATH")

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
    for e in data.get('errors', []):
        print(f\"  GitHub: {e.get('field','?')}: {e.get('message','')}\")
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
log "  $DEB_PATH"
log "  $APPIMAGE_PATH"
