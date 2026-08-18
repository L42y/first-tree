#!/usr/bin/env bash
# scripts/dev-install.sh — install the in-tree CLI as `first-tree-dev` on PATH.
#
# Source-tree CHANNEL is "dev" (set in apps/cli/src/build-info.ts), so the
# built binary already knows its identity: bin name `first-tree-dev` (alias
# `ftd`), default home `~/.first-tree-dev/`, default server
# http://127.0.0.1:8000, service unit `first-tree-dev.service` / launchd
# label `first-tree-dev`. Matches the staging / prod operational model
# (same verbs, separate service unit) — only difference is install method
# (symlink from this repo, not npm).
#
# Usage:
#   ./scripts/dev-install.sh                    # build + (re)link + restart installed daemon
#   ./scripts/dev-install.sh --quiet            # only errors and the final summary
#   first-tree-dev login <code>                # first-time setup creates the service
#   first-tree-dev daemon status                # same verbs as staging/prod
#
# Re-run this script after editing any source file to rebuild dist.
#
# Replaces scripts/dev-cli.sh (the FIRST_TREE_HOME wrapper). dev-install
# does NOT export FIRST_TREE_HOME — the built CLI handles channel
# resolution itself via apps/cli/src/core/channel-env.ts.

set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST="$REPO/apps/cli/dist/cli/index.mjs"
BIN_DIR="${HOME}/.local/bin"

# ---------------------------------------------------------------------------
# Terminal UI.
#
# Deliberately duplicated from scripts/portable/install.sh rather than shared:
# that file is published as a single self-contained object and consumed through
# `curl ... | sh`, so it cannot source a helper library. Keep the two copies
# conceptually in sync. This one may use bashisms; the portable installer may
# not (it runs under dash in CI).
# ---------------------------------------------------------------------------
QUIET=0
SHOW_BANNER=1
UI_COLOR=0
UI_UNICODE=0
UI_WIDTH=80
UI_STEP=0
UI_TOTAL_STEPS=6

C_RESET=""
C_DIM=""
C_BOLD=""
C_BRAND=""
C_WARN=""

G_OK="[ok]"
G_WARN="[!]"
G_ARROW="->"
G_DOT="-"
G_RULE="="

usage() {
  cat <<EOF
Usage: ./scripts/dev-install.sh [options]

Builds the in-tree CLI and links it onto PATH as first-tree-dev (alias ftd),
then restarts the installed dev daemon.

Options:
  --quiet, -q     Only print errors and the final summary
  --no-banner     Skip the startup banner
  --help, -h      Show this help

Environment:
  NO_COLOR        Set to any value to disable coloured output
EOF
}

while (($# > 0)); do
  case "$1" in
    --quiet | -q)
      QUIET=1
      SHOW_BANNER=0
      shift
      ;;
    --no-banner)
      SHOW_BANNER=0
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf '[dev-install] unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ui_detect() {
  if ((QUIET == 0)) && [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
    UI_COLOR=1
  fi

  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]*) UI_UNICODE=1 ;;
  esac

  # `tput cols` reports the terminfo default inside a command substitution,
  # because its stdout is a pipe and ncurses cannot ioctl the real terminal.
  # Duplicate a terminal descriptor and let stty ioctl that instead.
  local cols=""
  if [[ -t 1 ]]; then
    exec 9>&1
  elif [[ -t 2 ]]; then
    exec 9>&2
  fi
  if [[ -t 1 || -t 2 ]]; then
    cols="$(stty size <&9 2>/dev/null | awk '{print $2}' || true)"
    exec 9>&-
  fi
  [[ "$cols" =~ ^[0-9]+$ ]] || cols="$(tput cols 2>/dev/null || true)"
  [[ "$cols" =~ ^[0-9]+$ ]] || cols="${COLUMNS:-80}"
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=80
  ((cols >= 20)) || cols=80
  UI_WIDTH="$cols"

  if ((UI_COLOR == 1)); then
    local depth
    depth="$(tput colors 2>/dev/null || printf '8')"
    [[ "$depth" =~ ^[0-9]+$ ]] || depth=8
    # Brand green: --brand oklch(0.72 0.17 150) in packages/web/src/index.css.
    if ((depth >= 256)); then
      C_BRAND=$'\033[38;5;42m'
    else
      C_BRAND=$'\033[32m'
    fi
    C_RESET=$'\033[0m'
    C_DIM=$'\033[2m'
    C_BOLD=$'\033[1m'
    C_WARN=$'\033[33m'
  fi

  if ((UI_UNICODE == 1)); then
    G_OK="✓"
    G_WARN="⚠"
    G_ARROW="→"
    G_DOT="·"
    G_RULE="━"
  fi
}

# Suppressed by --quiet.
ui_step() {
  UI_STEP=$((UI_STEP + 1))
  ((QUIET == 0)) || return 0
  printf '\n%s\n' "${C_BOLD}  [${UI_STEP}/${UI_TOTAL_STEPS}] $1${C_RESET}"
}

# Section header for commands whose own output is passed through untouched.
ui_rule() {
  UI_STEP=$((UI_STEP + 1))
  ((QUIET == 0)) || return 0
  local title="${G_RULE}${G_RULE} [${UI_STEP}/${UI_TOTAL_STEPS}] $1 "
  local pad=$((UI_WIDTH - ${#title}))
  ((pad < 0)) && pad=0
  local fill=""
  local i
  for ((i = 0; i < pad; i++)); do fill+="$G_RULE"; done
  printf '\n%s\n\n' "${C_BOLD}${title}${fill}${C_RESET}"
}

ui_kv() {
  ((QUIET == 0)) || return 0
  printf '%s        %-14s %s%s\n' "$C_DIM" "$1" "$2" "$C_RESET"
}

# Completion line for a ui_rule section. pnpm and turbo end on a redrawn
# progress line, so open a blank line first rather than landing on top of it.
ui_section_ok() {
  ((QUIET == 0)) || return 0
  printf '\n'
  ui_ok "$@"
}

ui_detail() {
  ((QUIET == 0)) || return 0
  printf '%s        %s%s\n' "$C_DIM" "$*" "$C_RESET"
}

ui_ok() {
  ((QUIET == 0)) || return 0
  printf '%s  %s  %s%s\n' "$C_BRAND" "$G_OK" "$*" "$C_RESET"
}

ui_warn() {
  printf '%s  %s  %s%s\n' "$C_WARN" "$G_WARN" "$*" "$C_RESET"
}

# Fatal: goes to stderr so it survives a redirected stdout.
ui_fail() {
  printf '%s  %s  %s%s\n' "$C_WARN" "$G_WARN" "$*" "$C_RESET" >&2
}

# Relay captured child output on a success path. Suppressed by --quiet, which
# promises errors and the final summary only; failure paths below print the same
# text to stderr unconditionally.
ui_relay() {
  ((QUIET == 0)) || return 0
  [[ -n "$1" ]] || return 0
  printf '%s\n' "$1"
}

# Always printed.
say() {
  printf '%s\n' "$*"
}

# pnpm and turbo keep their inherited stdout/stderr by default: piping them
# would cost their own TTY progress rendering, which is better than anything
# this script could print in its place. Under --quiet there is nothing to
# preserve, so buffer instead and replay only if the command fails.
run_build_command() {
  if ((QUIET == 0)); then
    "$@"
    return
  fi
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/first-tree-dev-install.XXXXXX")"
  if "$@" >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  cat "$log" >&2
  rm -f "$log"
  return 1
}

ui_elapsed() {
  local secs=$(($(date +%s) - $1))
  ((secs >= 0)) || secs=0
  if ((secs < 60)); then
    printf '%ss' "$secs"
  else
    printf '%sm %ss' "$((secs / 60))" "$((secs % 60))"
  fi
}

print_banner() {
  ((SHOW_BANNER == 1)) || return 0
  ((QUIET == 0)) || return 0
  if ((UI_UNICODE != 1)) || [[ ! -t 1 ]] || ((UI_WIDTH < 60)); then
    printf '\n%s\n' "${C_BRAND}  first-tree ${G_DOT} dev installer ${G_DOT} https://first-tree.ai${C_RESET}"
    printf '%s\n' "${C_DIM}  dev ${G_DOT} in-tree build ${G_DOT} ${REPO}${C_RESET}"
    return 0
  fi
  printf '%s' "$C_BRAND"
  cat <<'BANNER'

     ▄█▄
    █████     ╔═╗╦╦═╗╔═╗╔╦╗  ╔╦╗╦═╗╔═╗╔═╗
   ▄█████▄    ╠╣ ║╠╦╝╚═╗ ║    ║ ╠╦╝║╣ ║╣
    █████     ╚  ╩╩╚═╚═╝ ╩    ╩ ╩╚═╚═╝╚═╝
   ▄█████▄
  ▄███████▄   Context-grounded agentic work for teams.
     ███      https://first-tree.ai
BANNER
  printf '%s' "$C_RESET"
  printf '%s\n' "${C_DIM}              dev ${G_DOT} in-tree build ${G_DOT} ${REPO}${C_RESET}"
}

ui_detect
print_banner
TOTAL_START=$(date +%s)

# Auto-migrate the legacy dev home from the pre-multi-env layout
# (scripts/dev-cli.sh used ~/.first-tree/hub-dev). One-shot mv — never
# copies, so the data structure is preserved bit-for-bit. Limited to
# the legacy dev-only path so it cannot touch peer staging / prod
# state (the cli-side auto unit cleanup was removed for that exact
# reason — see service-install.ts docblocks).
ui_step "Preparing dev home"
LEGACY_DEV_HOME="${HOME}/.first-tree/hub-dev"
NEW_DEV_HOME="${HOME}/.first-tree-dev"
if [[ -d "$LEGACY_DEV_HOME" && ! -d "$NEW_DEV_HOME" ]]; then
  ui_detail "migrating legacy dev home: $LEGACY_DEV_HOME $G_ARROW $NEW_DEV_HOME"
  mv "$LEGACY_DEV_HOME" "$NEW_DEV_HOME"
  ui_ok "Legacy dev home migrated"
else
  ui_kv "Home" "$NEW_DEV_HOME"
  ui_ok "Dev home ready"
fi

# Ensure all workspace packages are installed. Idempotent — a no-op
# when the lockfile already matches the on-disk state. Without this,
# any missing `packages/*/node_modules/.bin/tsdown` (e.g. after a
# fresh checkout or a lockfile bump) blows up `pnpm build` with the
# unhelpful "tsdown: not found" error from a transitive workspace
# package, not from us.
#
ui_rule "Installing workspace dependencies"
STEP_START=$(date +%s)
run_build_command pnpm install
ui_section_ok "Dependencies ready in $(ui_elapsed "$STEP_START")"

# Build everything (full monorepo). Turbo respects per-task
# `dependsOn` so packages build in dependency order, and a warm cache
# makes subsequent runs sub-second. Using `pnpm build` here keeps the
# dev workflow aligned with CI (`.github/workflows/ci.yml` also runs
# `pnpm build`) — any filter-based partial build risks the multi-env
# foot-gun of leaving `packages/shared/dist/` stale.
ui_rule "Building workspace (turbo)"
STEP_START=$(date +%s)
run_build_command pnpm build
ui_section_ok "Build finished in $(ui_elapsed "$STEP_START")"

# Symlink to user-local PATH. Both names point at the same dist so they
# stay in sync without a second link step.
ui_step "Linking CLI binaries"
mkdir -p "$BIN_DIR"
ln -sf "$DIST" "$BIN_DIR/first-tree-dev"
ln -sf "$DIST" "$BIN_DIR/ftd"
ui_kv "first-tree-dev" "$G_ARROW $DIST"
ui_kv "ftd" "$G_ARROW $DIST"
ui_ok "Linked into $BIN_DIR"

ui_step "Verifying installed CLI"
if cli_version=$("$BIN_DIR/first-tree-dev" --version 2>&1); then
  ui_kv "Version" "$cli_version"
  ui_ok "CLI starts from the freshly built dist"
else
  printf '%s\n' "$cli_version" >&2
  ui_fail "first-tree-dev --version failed; the link is in place but the build looks broken."
  exit 1
fi

ui_step "Restarting dev daemon"
if restart_output=$("$BIN_DIR/first-tree-dev" daemon restart 2>&1); then
  ui_relay "$restart_output"
  ui_ok "Daemon restarted on the new build"
elif grep -q "No background service installed" <<<"$restart_output"; then
  ui_relay "$restart_output"
  ui_detail "daemon service is not installed yet; run first-tree-dev login <code> to create it."
  ui_ok "Nothing to restart yet"
else
  printf "%s\n" "$restart_output" >&2
  ui_fail "Daemon restart failed; install output is on disk, but the running daemon was not updated."
  exit 1
fi

say ""
say "${C_BRAND}${C_BOLD}  $G_OK  first-tree-dev installed$C_RESET"
say "${C_DIM}        $DIST $G_DOT completed in $(ui_elapsed "$TOTAL_START")$C_RESET"
say ""
say "  Commands: $BIN_DIR/first-tree-dev, $BIN_DIR/ftd"
say ""
say "  Next:"
say "    1. Make sure $BIN_DIR is on \$PATH"
say "    2. Start your local First Tree server on http://127.0.0.1:8000"
say "    3. first-tree-dev login <code>      # token from http://127.0.0.1:8000/clients"
say ""
