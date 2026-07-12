#!/usr/bin/env bash
# cleanup-duplicate-pdfs.sh — Find and clean up duplicate PDF downloads in
# a Lumora file-storage folder.
#
# Usage:
#   ./cleanup-duplicate-pdfs.sh [DIR]            Dry-run scan (default)
#   ./cleanup-duplicate-pdfs.sh --delete [DIR]   Scan AND remove duplicates
#
# If DIR is omitted, reads the saved setting from Lumora's localStorage
# (macOS only). The script uses shasum -a 256 to detect identical files.
# For each group of files with the same content, it keeps the one with the
# simplest name (no collision suffix like "-2", shortest) and removes the
# rest.
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

# --- helpers -----------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

usage() {
  sed -n '1,/^$/s/^# //p' "$0"
  exit 0
}

format_bytes() {
  local bytes=$1
  if [ "$bytes" -lt 1024 ]; then
    echo "${bytes} B"
  elif [ "$bytes" -lt 1048576 ]; then
    awk "BEGIN { printf \"%.1f KB\", $bytes / 1024 }"
  elif [ "$bytes" -lt 1073741824 ]; then
    awk "BEGIN { printf \"%.1f MB\", $bytes / 1048576 }"
  else
    awk "BEGIN { printf \"%.1f GB\", $bytes / 1073741824 }"
  fi
}

is_collision_suffixed() {
  # e.g. "title-2.pdf", "paper-12.pdf" — stem ends with "-<digits>"
  local stem="${1%.pdf}"
  printf '%s' "$stem" | grep -qE -- '-[0-9]+$'
}

# Prints a sort key for keeper priority:
#   "0|NNNN|name" for collision-suffixed (lower priority)
#   "1|NNNN|name" for non-collision-suffixed (higher priority)
keeper_sort_key() {
  local name="$1"
  local prio="1"
  if is_collision_suffixed "$name"; then
    prio="0"
  fi
  printf '%s|%04d|%s\n' "$prio" "${#name}" "$name"
}

# --- argument parsing --------------------------------------------------

DO_DELETE=false
DIR=""

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage ;;
    --delete) DO_DELETE=true ;;
    *) DIR="$arg" ;;
  esac
done

if [ -z "$DIR" ]; then
  # Try to read the saved directory from Lumora's localStorage on macOS.
  APP_DIR="${HOME}/Library/Application Support/com.lumora.desktop"
  if [ -d "$APP_DIR" ]; then
    LS_FILE=$(find "$APP_DIR" -maxdepth 3 -name '*.localstorage' 2>/dev/null | head -1)
    if [ -n "$LS_FILE" ]; then
      RAW=$(sqlite3 "$LS_FILE" \
        "SELECT value FROM ItemTable WHERE key = 'lumora:file-storage-settings'" 2>/dev/null || true)
      if [ -n "$RAW" ]; then
        DIR=$(python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('directory',''))" <<<"$RAW" 2>/dev/null || true)
      fi
    fi
  fi
  if [ -z "$DIR" ]; then
    echo -e "${RED}Error: No directory given and could not read Lumora settings.${RESET}"
    echo "Usage: $0 [--delete] /path/to/storage/folder"
    exit 1
  fi
  echo -e "${CYAN}Read storage folder from Lumora settings: ${DIR}${RESET}"
fi

if [ ! -d "$DIR" ]; then
  echo -e "${RED}Error: Not a directory: ${DIR}${RESET}"
  exit 1
fi

# --- scan --------------------------------------------------------------

echo -e "${BOLD}Scanning for duplicate PDFs in: ${DIR}${RESET}"

# Count pdfs.
shopt -s nullglob
PDF_COUNT=0
for f in "$DIR"/*.pdf "$DIR"/*.PDF; do
  [ -f "$f" ] && PDF_COUNT=$((PDF_COUNT + 1))
done
shopt -u nullglob

if [ "$PDF_COUNT" -le 1 ]; then
  echo "Found ${PDF_COUNT} PDF file(s). Nothing to deduplicate."
  exit 0
fi

echo -e "Found ${PDF_COUNT} PDF files. Computing SHA-256 hashes..."
echo ""

# Temp files. We clean them all on exit.
HASH_FILE=$(mktemp -t cleanup-hashes.XXXXXX)
SORTED_FILE=$(mktemp -t cleanup-sorted.XXXXXX)
GROUP_TMP=$(mktemp -t cleanup-gtmp.XXXXXX)
GROUPS_FILE=$(mktemp -t cleanup-groups.XXXXXX)
UNIQUE_FILE=$(mktemp -t cleanup-unique.XXXXXX)
trap 'rm -f "$HASH_FILE" "$SORTED_FILE" "$GROUP_TMP" "${GROUP_TMP}.dels" "$GROUPS_FILE" "$UNIQUE_FILE"' EXIT

for f in "$DIR"/*.pdf "$DIR"/*.PDF; do
  [ -f "$f" ] || continue
  name="${f##*/}"
  hash=$(shasum -a 256 "$f" | awk '{print $1}')
  size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
  printf '%s|%s|%s\n' "$hash" "$name" "$size" >> "$HASH_FILE"
done

# Sort by hash so identical hashes are contiguous.
sort -t'|' -k1,1 "$HASH_FILE" > "$SORTED_FILE"

# --- analyze -----------------------------------------------------------

CURRENT_HASH=""
CURRENT_SIZE=""
: > "$GROUP_TMP"

flush_group() {
  if [ -z "$CURRENT_HASH" ]; then
    return
  fi

  local count
  count=$(wc -l < "$GROUP_TMP" | tr -d ' ')

  if [ "$count" -le 1 ]; then
    echo "$CURRENT_HASH" >> "$UNIQUE_FILE"
    : > "$GROUP_TMP"
    CURRENT_HASH=""
    CURRENT_SIZE=""
    return
  fi

  # Sort this group's entries by keeper priority and write to a temp file.
  local sorted_group
  sorted_group=$(mktemp -t cleanup-sg.XXXXXX)
  sort -t'|' -k1,1r -k2,2n -k3,3 "$GROUP_TMP" > "$sorted_group"

  # Read sorted entries: prio|len|name
  local keeper=""
  local dels=""
  local line_num=0
  while IFS='|' read -r prio plen name; do
    line_num=$((line_num + 1))
    if [ "$line_num" -eq 1 ]; then
      keeper="$name"
    else
      if [ -z "$dels" ]; then
        dels="$name"
      else
        dels="${dels}|${name}"
      fi
    fi
  done < "$sorted_group"
  rm -f "$sorted_group"

  echo "${CURRENT_HASH}|${CURRENT_SIZE}|${keeper}|${dels}" >> "$GROUPS_FILE"
  : > "$GROUP_TMP"
  CURRENT_HASH=""
  CURRENT_SIZE=""
}

# Walk the pre-sorted hash file, accumulating groups.
while IFS='|' read -r hash name size; do
  if [ "$hash" != "$CURRENT_HASH" ]; then
    flush_group
    CURRENT_HASH="$hash"
    CURRENT_SIZE="$size"
    : > "$GROUP_TMP"
  fi
  keeper_sort_key "$name" >> "$GROUP_TMP"
done < "$SORTED_FILE"
flush_group

# Count unique hashes.
UNIQUE_COUNT=0
if [ -f "$UNIQUE_FILE" ]; then
  UNIQUE_COUNT=$(wc -l < "$UNIQUE_FILE" | tr -d ' ')
fi

# --- display results ---------------------------------------------------

TOTAL_TO_REMOVE=0
TOTAL_BYTES_FREED=0
GROUP_COUNT=0

if [ -f "$GROUPS_FILE" ]; then
  while IFS='|' read -r hash size keeper rest; do
    GROUP_COUNT=$((GROUP_COUNT + 1))
    UNIQUE_COUNT=$((UNIQUE_COUNT + 1))

    # Count DEL entries for this group outside any pipeline.
    local_dels=0
    if [ -n "$rest" ]; then
      local_dels=$(printf '%s\n' "$rest" | tr '|' '\n' | grep -c .)
    fi

    echo -e "${BOLD}Duplicate group — sha256: ${hash:0:12}…${RESET}"
    echo -e "  ${GREEN}KEEP${RESET}  ${keeper}  ($(format_bytes "$size"))"

    if [ -n "$rest" ]; then
      # Print each DEL name — use a file to avoid subshell.
      printf '%s\n' "$rest" | tr '|' '\n' > "${GROUP_TMP}.dels"
      while IFS= read -r name; do
        [ -z "$name" ] && continue
        echo -e "  ${RED}DEL${RESET}   ${name}  ($(format_bytes "$size"))"
      done < "${GROUP_TMP}.dels"
      rm -f "${GROUP_TMP}.dels"
    fi

    TOTAL_TO_REMOVE=$((TOTAL_TO_REMOVE + local_dels))
    TOTAL_BYTES_FREED=$((TOTAL_BYTES_FREED + local_dels * size))
    echo ""
  done < "$GROUPS_FILE"
fi

# --- summary -----------------------------------------------------------

echo -e "${BOLD}────────────────────────────────────────${RESET}"
echo -e "Files scanned:     ${PDF_COUNT}"
echo -e "Unique hashes:     ${UNIQUE_COUNT}"
echo -e "Duplicate groups:  ${GROUP_COUNT}"
echo -e "Files to remove:   ${TOTAL_TO_REMOVE}"
echo -e "Space to free:     $(format_bytes "$TOTAL_BYTES_FREED")"

if [ "$GROUP_COUNT" -eq 0 ]; then
  echo -e "\n${GREEN}No duplicate downloads found.${RESET}"
  exit 0
fi

if [ "$DO_DELETE" != true ]; then
  echo -e "\n${YELLOW}Dry run — no files removed. Run with --delete to clean up.${RESET}"
  exit 0
fi

# --- delete ------------------------------------------------------------

echo -e "\n${BOLD}Removing duplicate files...${RESET}"
REMOVED=0

while IFS='|' read -r hash size keeper rest; do
  if [ -n "$rest" ]; then
    printf '%s\n' "$rest" | tr '|' '\n' > "${GROUP_TMP}.dels"
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      rm -f "$DIR/$name"
      echo "  Removed: $name"
      REMOVED=$((REMOVED + 1))
    done < "${GROUP_TMP}.dels"
    rm -f "${GROUP_TMP}.dels"
  fi
done < "$GROUPS_FILE"

echo -e "\n${GREEN}Done. Removed ${REMOVED} duplicate file(s), freed $(format_bytes "$TOTAL_BYTES_FREED").${RESET}"
echo -e "${YELLOW}Note: Library records in Lumora may still reference removed files.${RESET}"
echo -e "${YELLOW}Restart Lumora to run startup reconciliation and fix stale references.${RESET}"
