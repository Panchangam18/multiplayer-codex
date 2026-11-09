#!/bin/bash
set -euo pipefail

install_multiplayer_codex() (
  local version="0.3.1"
  local checksum="bc9ec5ec7f29849c490d5310666919eb2a36f95cfa137cc72548de29fc067a3a"
  local launch=1
  case "${1:-}" in
    --no-open) launch=0 ;;
    --help) printf 'Usage: bash install.sh [--no-open]\nInstalls Multiplayer Codex to ~/Applications without sudo.\n'; return ;;
    "") ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
  esac
  if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    printf 'This download requires an Apple-silicon Mac. See docs/installation.md for source builds.\n' >&2
    return 1
  fi
  local macos_version
  macos_version="$(sw_vers -productVersion)"
  if (( ${macos_version%%.*} < 14 )); then
    printf 'Multiplayer Codex requires macOS 14 or newer.\n' >&2
    return 1
  fi
  if [[ "$(id -u)" == 0 ]]; then
    printf 'Run this as your normal user, without sudo.\n' >&2
    return 1
  fi
  local destination="$HOME/Applications/Multiplayer Codex.app"
  local plist="$destination/Contents/Info.plist"
  if [[ -L "$destination" || ( -e "$destination" && ! -d "$destination" ) ]]; then
    printf 'Refusing to replace a symlink or non-app file at %s\n' "$destination" >&2
    return 1
  fi
  if [[ -d "$destination" ]]; then
    if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null)" != com.multiplayer-codex.companion ]]; then
      printf 'An unrelated app exists at %s; move it before installing.\n' "$destination" >&2
      return 1
    fi
    if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$version" ]] && codesign --verify --deep --strict "$destination" 2>/dev/null; then
      printf 'Multiplayer Codex %s is already installed.\n' "$version"
      if (( launch )); then open "$destination"; fi
      return
    fi
    if pgrep -f '[M]ultiplayer Codex.app/Contents/MacOS/MultiplayerCodex' >/dev/null; then
      printf 'Quit Multiplayer Codex from its menu-bar icon, then rerun this command. Codex can stay open.\n' >&2
      return 1
    fi
  fi
  local filename="Multiplayer-Codex-$version-macos-arm64.zip"
  local stage
  mkdir -p "$HOME/Applications"
  stage="$(mktemp -d "$HOME/Applications/.multiplayer-install.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  printf 'Downloading Multiplayer Codex %s…\n' "$version"
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 300 \
    "https://github.com/Panchangam18/multiplayer-codex/releases/download/v$version/$filename" -o "$stage/download.zip"
  if [[ "$(shasum -a 256 "$stage/download.zip" | awk '{print $1}')" != "$checksum" ]]; then
    printf 'Download checksum mismatch. Nothing was installed.\n' >&2
    return 1
  fi
  ditto -x -k "$stage/download.zip" "$stage/unpacked"
  local app="$stage/unpacked/Multiplayer Codex.app"
  codesign --verify --deep --strict "$app"
  if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != com.multiplayer-codex.companion || "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" != "$version" ]]; then
    printf 'Unexpected app identity or version. Nothing was installed.\n' >&2
    return 1
  fi
  local backup=""
  if [[ -e "$destination" ]]; then
    backup="$(mktemp -d "$HOME/Applications/.multiplayer-backup.XXXXXX")/Multiplayer Codex.app"
    mv "$destination" "$backup"
  fi
  if ! mv "$app" "$destination"; then
    if [[ -n "$backup" ]]; then mv "$backup" "$destination"; fi
    printf 'Installation failed; any previous app was restored.\n' >&2
    return 1
  fi
  printf 'Installed to %s\n' "$destination"
  if [[ -n "$backup" ]]; then printf 'Previous version saved at %s\n' "$backup"; fi
  printf 'Unofficial, unnotarized preview. No macOS security settings were changed.\n'
  printf 'Next: people icon in the menu bar → Enable Multiplayer. Install on each Mac, then right-click a chat → Multiplayer.\n'
  if (( launch )); then
    if ! open "$destination"; then
      printf 'Installed, but macOS did not open it. See https://github.com/Panchangam18/multiplayer-codex/blob/main/docs/installation.md#preview-security-warning\n' >&2
      return 1
    fi
  fi
)

install_multiplayer_codex "$@"
