#!/usr/bin/env bash
#
# deploy.sh - set up, build and run OurHomeInbox.
#
# First run: creates the repo-root config.yml and .env from their templates
# and walks through the settings for a Proton Mail mailbox (what each one is
# for and where to get it). Later runs ask once whether to change settings;
# "no" deploys straight away.
#
# Settings live in the repo-root config.yml and secrets in the repo-root .env
# (both shared with local dev). Only the walkthrough writes them. Compose
# passes .env to the container and mounts config.yml into it; this script
# reads config.yml's `docker:` section (with a pinned yq container, so nothing
# needs installing) into .compose.env, which compose uses for the network.
#
# For now OurHomeInbox checks each mailbox and exits, so this runs it in the
# foreground and reports the result.
#
# Usage:  ./deploy.sh [-n] [-s|-y] [--no-build]

set -uo pipefail

# ---------------------------------------------------------------------------
# Run from this script's directory (= docker/) so all compose paths resolve.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR" || exit 1
SETTINGS=../config.yml     # the repo-root settings, shared with local dev
SECRETS=../.env            # the repo-root secrets; compose passes them to the app
ENV_FILE=.compose.env      # generated from SETTINGS on every run; don't edit
YQ_IMAGE=mikefarah/yq:4.44.3
# config.yml `docker:` section -> DOCKER_* for compose.
YQ_EXPR='.docker // {} | to_entries | .[] | "DOCKER_" + (.key | upcase) + "=" + ((.value // "") | tostring)'
SERVICE=ourhome-inbox
# The Proton Bridge from OurHomeServices: its container, and its setup guide.
BRIDGE_CONTAINER=ourhome_bridge
BRIDGE_DOCS=https://github.com/EOSOClub/OurHomeServices/tree/main/proton-bridge
# The username in config.example.yml; still there means "not set yet".
PLACEHOLDER_USER=you@proton.me

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
NO_BUILD=0
NO_CACHE=0
SETUP=ask      # ask | yes (-s) | no (-y)

usage() {
  cat <<EOF
${BOLD}OurHomeInbox - Docker deploy${RESET}

Sets up settings on the first run, builds OurHomeInbox from this checkout,
then runs it and reports whether every mailbox could be reached.

${BOLD}Usage:${RESET}
  ./deploy.sh [options]

${BOLD}Options:${RESET}
  -n, --no-cache       Rebuild every layer and re-pull the base image.
  -s, --setup          Go straight to the settings walkthrough.
  -y, --yes            Don't ask about settings; deploy with what is saved.
      --no-build       Skip rebuilding the image; just run it.
  -h, --help           Show this help and exit.

${BOLD}Environment:${RESET}
  NO_COLOR             Set to disable coloured output.

The first run creates config.yml and .env (repo root) from their templates.
EOF
}

# ---------------------------------------------------------------------------
# Colours - disabled when NO_COLOR is set or stdout is not a TTY.
# ---------------------------------------------------------------------------
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  MAGENTA=$'\033[35m'; CYAN=$'\033[36m'
else
  RESET='' BOLD='' DIM='' RED='' GREEN='' YELLOW='' MAGENTA='' CYAN=''
fi
# Questions need a keyboard; without one (cron, CI) settings are never asked.
if [ -t 0 ]; then CAN_ASK=1; else CAN_ASK=0; fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
info()  { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$*"; }
errln() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

DC_STR="docker compose"   # for hint messages; resolved for real below

fail() {
  errln "$*"
  printf '\n%sDeploy aborted.%s  Inspect logs with: %s%s logs%s\n' \
    "$RED$BOLD" "$RESET" "$BOLD" "$DC_STR" "$RESET" >&2
  exit 1
}

STEP_N=0
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n  %s── %s · %s%s\n' "$BOLD" "$STEP_N" "$*" "$RESET"
}

banner() {
  printf '\n  %s%sO U R   H O M E   I N B O X · deploy%s\n' "$MAGENTA" "$BOLD" "$RESET"
  printf '  %sreads bills from email for Our Home%s\n' "$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# .compose.env / .env reader (handles CRLF, surrounding quotes)
# ---------------------------------------------------------------------------
env_get() {  # $1 key  [$2 file]
  local key=$1 file=${2:-$ENV_FILE} line val
  [ -f "$file" ] || return 1
  line=$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n1) || return 1
  [ -n "$line" ] || return 1
  val=${line#*=}
  val=${val%$'\r'}
  val="${val#"${val%%[![:space:]]*}"}"   # ltrim
  val="${val%"${val##*[![:space:]]}"}"   # rtrim
  val=${val#\"}; val=${val%\"}
  val=${val#\'}; val=${val%\'}
  printf '%s' "$val"
}

# Replace KEY=… in an env file, or append it. awk takes the value from the
# environment, so no character in a secret needs escaping.
env_put_file() {  # $1 file  $2 key  $3 value
  local tmp
  tmp=$(mktemp) || return 1
  if grep -qE "^[[:space:]]*$2=" "$1"; then
    K="$2" V="$3" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
      $0 ~ "^[[:space:]]*" k "=" { print k "=" v; next } { print }' "$1" > "$tmp"
  else
    cat "$1" > "$tmp"
    [ ! -s "$1" ] || [ -z "$(tail -c1 "$1")" ] || printf '\n' >> "$tmp"
    printf '%s=%s\n' "$2" "$3" >> "$tmp"
  fi
  # cat > keeps the file's owner and mode (.env can stay 600).
  cat "$tmp" > "$1"; rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------
ask() {  # $1 question  [$2 default] -> REPLY
  if [ -n "${2:-}" ]; then printf '  %s %s[%s]%s: ' "$1" "$DIM" "$2" "$RESET"; else printf '  %s: ' "$1"; fi
  IFS= read -r REPLY || REPLY=
  REPLY=${REPLY%$'\r'}
  [ -n "$REPLY" ] || REPLY=${2:-}
}

ask_secret() {  # $1 question  $2 1 when one is saved already -> REPLY ("" = keep it)
  if [ "$2" = 1 ]; then printf '  %s %s[Enter keeps the saved one]%s: ' "$1" "$DIM" "$RESET"; else printf '  %s: ' "$1"; fi
  IFS= read -rs REPLY || REPLY=
  printf '\n'
  REPLY=${REPLY%$'\r'}
}

ask_yn() {  # $1 question  $2 default y|n; returns 0 for yes
  local hint=y/N
  [ "$2" = y ] && hint=Y/n
  while true; do
    printf '  %s %s[%s]%s ' "$1" "$DIM" "$hint" "$RESET"
    IFS= read -r REPLY || REPLY=
    REPLY=${REPLY%$'\r'}; REPLY=${REPLY:-$2}
    case "$REPLY" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Settings walkthrough
# ---------------------------------------------------------------------------
# Asks about the first mailbox in config.yml (its IMAP connection and folder)
# and the Docker network. Answers are held until the end, so quitting part way
# (Ctrl+C) changes nothing, and only what changed is written back.
setup_wizard() {
  local out line count=0 host="" port="" security="" user="" folder="" pw_env="" net="" has_pw=0
  local new_host new_port new_security new_user new_pw new_folder new_net expr="" sep="" tmp args=()

  out=$(docker run --rm -i "$YQ_IMAGE" '"count=" + (.mailboxes // [] | length | tostring),
      "host=" + ((.mailboxes[0].imap.host // "") | tostring),
      "port=" + ((.mailboxes[0].imap.port // "") | tostring),
      "security=" + ((.mailboxes[0].imap.security // "") | tostring),
      "user=" + ((.mailboxes[0].imap.username // "") | tostring),
      "pw_env=" + ((.mailboxes[0].imap.password_env // "") | tostring),
      "folder=" + ((.mailboxes[0].folder // "") | tostring),
      "net=" + ((.docker.network // "") | tostring)' < "$SETTINGS") \
    || fail "Could not read config.yml - check it is valid YAML."
  while IFS= read -r line; do
    case "$line" in
      count=*)    count=${line#*=} ;;
      host=*)     host=${line#*=} ;;
      port=*)     port=${line#*=} ;;
      security=*) security=${line#*=} ;;
      user=*)     user=${line#*=} ;;
      pw_env=*)   pw_env=${line#*=} ;;
      folder=*)   folder=${line#*=} ;;
      net=*)      net=${line#*=} ;;
    esac
  done <<< "$out"
  [ "$count" -gt 0 ] 2>/dev/null \
    || fail "config.yml has no mailboxes. Copy the mailbox from config.example.yml into it."
  [ -n "$pw_env" ] || pw_env=PROTON_BRIDGE_PASSWORD
  [ -n "$(env_get "$pw_env" "$SECRETS" || true)" ] && has_pw=1

  step "Proton Mail mailbox: IMAP connection"
  info "OurHomeInbox reads mail over IMAP (it never sends, so there is no SMTP)."
  info "Proton Mail is read through Proton Mail Bridge. Its \"info\" command prints"
  info "the IMAP username and password asked for here. The password is made by"
  info "the Bridge: it is not your Proton password. No Bridge yet? OurHomeServices"
  info "has one ready to run: $BRIDGE_DOCS"
  [ "$count" -gt 1 ] && info "This sets up the first mailbox; edit config.yml for the other $((count - 1))."
  printf '\n'

  info "For a Bridge container, the IMAP server is its name on the Docker network."
  ask "IMAP server" "${host:-protonmail-bridge}"; new_host=$REPLY

  while true; do
    ask "IMAP port" "${port:-143}"; new_port=$REPLY
    [[ $new_port =~ ^[0-9]+$ ]] && [ "$new_port" -ge 1 ] && [ "$new_port" -le 65535 ] && break
    warn "A port is a number from 1 to 65535 (usually 143, or 993 for tls)."
  done

  info "Security: none (no encryption; only inside one machine or Docker network),"
  info "starttls (connects, then switches to encryption), or tls (encrypted from"
  info "the start, \"SSL/TLS\" in mail apps). Proton Mail Bridge in Docker: none,"
  info "because its certificate is only valid for 127.0.0.1."
  while true; do
    ask "IMAP security (none, starttls or tls)" "${security:-none}"; new_security=$REPLY
    case "$new_security" in none|starttls|tls) break ;; esac
    warn "Type none, starttls or tls."
  done

  [ "$user" = "$PLACEHOLDER_USER" ] && user=""
  while true; do
    ask "IMAP username (for the Bridge, your Proton address)" "$user"; new_user=$REPLY
    [ -n "$new_user" ] && break
    warn "The username is needed."
  done

  while true; do
    ask_secret "IMAP password" "$has_pw"; new_pw=$REPLY
    [ -n "$new_pw" ] || [ "$has_pw" = 1 ] && break
    warn "The password is needed. For the Bridge, its \"info\" command shows it."
  done

  info "Proton folders show up as \"Folders/<name>\", labels as \"Labels/<name>\"."
  ask "IMAP folder your bills are filtered into" "${folder:-INBOX}"; new_folder=$REPLY

  step "Docker"
  info "OurHomeInbox joins this Docker network. It must be the network your"
  info "IMAP server (the Bridge container) is on."
  while true; do
    ask "Docker network" "${net:-ourhome_net}"; new_net=$REPLY
    [[ $new_net =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] && break
    warn "Use letters, numbers, dots, dashes and underscores only."
  done

  # Only the keys that changed are rewritten. The port goes in as a number.
  if [ "$new_host" != "$host" ]; then
    export W_HOST=$new_host; args+=(-e W_HOST)
    expr+="$sep.mailboxes[0].imap.host = strenv(W_HOST)"; sep=" | "
  fi
  if [ "$new_port" != "$port" ]; then
    export W_PORT=$new_port; args+=(-e W_PORT)
    expr+="$sep.mailboxes[0].imap.port = (strenv(W_PORT) | to_number)"; sep=" | "
  fi
  if [ "$new_security" != "$security" ]; then
    export W_SECURITY=$new_security; args+=(-e W_SECURITY)
    expr+="$sep.mailboxes[0].imap.security = strenv(W_SECURITY)"; sep=" | "
  fi
  if [ "$new_user" != "$user" ]; then
    export W_USER=$new_user; args+=(-e W_USER)
    expr+="$sep.mailboxes[0].imap.username = strenv(W_USER)"; sep=" | "
  fi
  if [ "$new_folder" != "$folder" ]; then
    export W_FOLDER=$new_folder; args+=(-e W_FOLDER)
    expr+="$sep.mailboxes[0].folder = strenv(W_FOLDER)"; sep=" | "
  fi
  if [ "$new_net" != "$net" ]; then
    export W_NET=$new_net; args+=(-e W_NET)
    expr+="$sep.docker.network = strenv(W_NET)"; sep=" | "
  fi

  printf '\n'
  if [ -n "$expr" ]; then
    tmp=$(mktemp) || fail "Could not save config.yml."
    # yq keeps comments but drops blank lines, so they ride through as a
    # marker comment.
    if sed 's/^[[:space:]]*$/#__blank__/' "$SETTINGS" \
        | docker run --rm -i "${args[@]}" "$YQ_IMAGE" "$expr" \
        | sed -E 's/^[[:space:]]*#__blank__[[:space:]]*$//' > "$tmp" \
        && [ -s "$tmp" ]; then
      cat "$tmp" > "$SETTINGS"; rm -f "$tmp"
      ok "Saved config.yml"
    else
      rm -f "$tmp"; fail "Could not save config.yml."
    fi
  else
    ok "config.yml unchanged"
  fi
  if [ -n "$new_pw" ]; then
    env_put_file "$SECRETS" "$pw_env" "$new_pw" || fail "Could not save the password in .env."
    ok "Saved the IMAP password in .env ($pw_env)"
  fi
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--no-cache)  NO_CACHE=1 ;;
    -s|--setup)     SETUP=yes ;;
    -y|--yes)       SETUP=no ;;
    --no-build)     NO_BUILD=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)              printf 'Unknown option: %s\n\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

# ===========================================================================
banner

# --- Preflight -------------------------------------------------------------
step "Preflight checks"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed or not on PATH."
ok "docker found ($(docker --version 2>/dev/null | head -n1))"

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable. Is Docker running?"
ok "Docker daemon is running"

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 not found (need 'docker compose')."
DC=(docker compose --env-file "$ENV_FILE")
DC_STR="${DC[*]}"
ok "Compose available (${DC_STR})"

[ -f docker-compose.yml ] || fail "docker-compose.yml not found in $SCRIPT_DIR."

# --- Settings --------------------------------------------------------------
step "Settings"

FIRST_RUN=0
if [ ! -f "$SETTINGS" ]; then
  [ -f ../config.example.yml ] || fail "Missing config.yml and its template config.example.yml in the repo root."
  cp ../config.example.yml "$SETTINGS" || fail "Could not create config.yml."
  ok "Created config.yml from the template"
  FIRST_RUN=1
fi
if [ ! -f "$SECRETS" ]; then
  [ -f ../.env.example ] || fail "Missing .env and its template .env.example in the repo root."
  (umask 077 && cp ../.env.example "$SECRETS") || fail "Could not create .env."
  ok "Created .env from the template (readable only by you)"
  FIRST_RUN=1
fi

if [ "$FIRST_RUN" = 1 ] || [ "$SETUP" = yes ]; then
  [ "$CAN_ASK" = 1 ] || fail "Settings need answers; run ./deploy.sh in a terminal (or fill in ../config.yml and ../.env by hand)."
  setup_wizard
elif [ "$SETUP" = ask ] && [ "$CAN_ASK" = 1 ]; then
  ok "Settings present (../config.yml, ../.env)"
  if ask_yn "Change settings before deploying?" n; then setup_wizard; fi
else
  ok "Settings present (../config.yml, ../.env)"
fi

# Read the docker: section for compose.
info "reading config.yml (${YQ_IMAGE})…"
docker run --rm -i "$YQ_IMAGE" "$YQ_EXPR" < "$SETTINGS" > "$ENV_FILE" \
  || fail "Could not read config.yml - check it is valid YAML."
NETWORK=$(env_get DOCKER_NETWORK || true); NETWORK=${NETWORK:-ourhome_net}
ok "Compose values read ($(grep -c . "$ENV_FILE") from config.yml)"

# --- Network and Bridge ----------------------------------------------------
step "Docker network and Proton Bridge"

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  ok "Docker network $NETWORK exists"
elif [ "$CAN_ASK" = 1 ] && ask_yn "The Docker network $NETWORK does not exist. Create it?" y; then
  docker network create "$NETWORK" >/dev/null || fail "Could not create the Docker network $NETWORK."
  ok "Created the Docker network $NETWORK"
else
  fail "The Docker network $NETWORK does not exist. Create it with: docker network create $NETWORK"
fi

if docker ps --filter "name=^${BRIDGE_CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
  ok "Proton Bridge is running ($BRIDGE_CONTAINER)"
else
  warn "No running Proton Bridge ($BRIDGE_CONTAINER). The mailbox check will fail until"
  warn "it runs on $NETWORK. Setup: $BRIDGE_DOCS"
fi

# --- Build -----------------------------------------------------------------
if [ "$NO_BUILD" = 1 ]; then
  info "Skipping the build (--no-build)"
else
  BUILD_ARGS=()
  if [ "$NO_CACHE" = 1 ]; then
    step "Build (no cache)"
    BUILD_ARGS=(--no-cache --pull)
  else
    step "Build"
  fi
  "${DC[@]}" build "${BUILD_ARGS[@]}" || fail "The build failed (see above)."
  ok "Image built"
fi

# --- Run -------------------------------------------------------------------
step "Check mailboxes"
"${DC[@]}" up --no-build --exit-code-from "$SERVICE"
RC=$?

step "Summary"
if [ "$RC" = 0 ]; then
  ok "Every mailbox was reached."
else
  errln "Not every mailbox was reached (exit code $RC). The lines above say why."
  info "Fix it, then run ./deploy.sh again. To change settings: ./deploy.sh -s"
fi
exit "$RC"
