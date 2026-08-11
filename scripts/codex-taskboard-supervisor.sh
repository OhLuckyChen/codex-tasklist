#!/bin/zsh
set -uo pipefail

export CODEX_TASKBOARD_HOST="127.0.0.1"
export CODEX_TASKBOARD_PORT="47823"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
injector="$script_dir/codex-injector.mjs"
codex_executable="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
cdp_port="9229"
cdp_version_url="http://127.0.0.1:${cdp_port}/json/version"
child_pid=""
attached_cdp_signature=""
last_state=""
node_path_file="$project_root/.data/node-path"
codex_path_file="$project_root/.data/codex-path"

log() {
  /bin/echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*"
}

typeset -a taskboard_path
[[ -n "${HOME:-}" ]] && taskboard_path+=("$HOME/.npm-global/bin" "$HOME/.local/bin")
taskboard_path+=(/opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin)
export PATH="${(j/:/)taskboard_path}${PATH:+:$PATH}"

resolve_executable() {
  local env_value="$1"
  local path_file="$2"
  local command_name="$3"
  local candidate
  if [[ -n "$env_value" && -x "$env_value" ]]; then
    /bin/echo "$env_value"
    return 0
  fi
  if [[ -r "$path_file" ]]; then
    IFS= read -r candidate < "$path_file"
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      /bin/echo "$candidate"
      return 0
    fi
  fi
  candidate="$(command -v "$command_name" 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    /bin/echo "$candidate"
    return 0
  fi
  return 1
}

node_binary="$(resolve_executable "${CODEX_TASKBOARD_NODE:-}" "$node_path_file" node || true)"
if [[ -z "$node_binary" ]]; then
  log "Node.js executable not found. Re-run scripts/install-macos-launcher.sh or set CODEX_TASKBOARD_NODE."
  exit 1
fi

if [[ -z "${CODEX_EXECUTABLE:-}" ]]; then
  codex_cli="$(resolve_executable "" "$codex_path_file" codex || true)"
  [[ -n "$codex_cli" ]] && export CODEX_EXECUTABLE="$codex_cli"
fi

cdp_signature() {
  /usr/bin/curl -fsS --max-time 1 "$cdp_version_url" 2>/dev/null
}

codex_is_running() {
  /bin/ps -axo command= \
    | /usr/bin/awk -v expected="$codex_executable" '
      index($0, expected) == 1 {
        suffix = substr($0, length(expected) + 1, 1)
        if (suffix == "" || suffix == " ") found = 1
      }
      END { exit found ? 0 : 1 }
    '
}

resident_injector_pids() {
  /bin/ps -axo pid=,command= \
    | /usr/bin/awk -v injector="$injector" -v port="$cdp_port" '
      {
        pid = $1
        sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
        watches = index($0, injector) && index($0, "--watch")
        has_any_port = $0 ~ /(^|[[:space:]])--port(=|[[:space:]])/
        explicit_port = index($0, "--port " port) || index($0, "--port=" port)
        targets_port = explicit_port || !has_any_port
        if (watches && targets_port) print pid
      }
    '
}

stop_duplicate_injectors() {
  local keep_pid="${1:-}"
  resident_injector_pids | while IFS= read -r duplicate_pid; do
    [[ -n "$duplicate_pid" && "$duplicate_pid" != "$keep_pid" ]] || continue
    log "Stopping duplicate Taskboard injector pid $duplicate_pid on CDP port $cdp_port"
    /bin/kill -TERM "$duplicate_pid" 2>/dev/null || true
  done
}

log_state_once() {
  local state="$1"
  shift
  if [[ "$last_state" != "$state" ]]; then
    log "$*"
    last_state="$state"
  fi
}

stop_child() {
  if [[ -n "$child_pid" ]] && /bin/kill -0 "$child_pid" 2>/dev/null; then
    /bin/kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=""
  attached_cdp_signature=""
}

shutdown() {
  stop_child
  exit 0
}

trap shutdown INT TERM HUP

cd "$project_root" || exit 1
log "Codex Taskboard passive supervisor started"

while true; do
  current_cdp_signature="$(cdp_signature || true)"
  if [[ -n "$current_cdp_signature" ]]; then
    child_is_running=false
    if [[ -n "$child_pid" ]] && /bin/kill -0 "$child_pid" 2>/dev/null; then
      child_is_running=true
    fi

    if [[ "$child_is_running" == true && "$attached_cdp_signature" == "$current_cdp_signature" ]]; then
      stop_duplicate_injectors "$child_pid"
      /bin/sleep 0.5
      continue
    fi

    stop_child
    stop_duplicate_injectors
    /bin/sleep 0.2
    log "Detected a new Codex CDP instance on 127.0.0.1:${cdp_port}; starting a fresh Taskboard injector"
    "$node_binary" "$injector" --port "$cdp_port" --watch --open --attach-existing &
    child_pid="$!"
    attached_cdp_signature="$current_cdp_signature"
    last_state="attached"
    /bin/sleep 0.5
    continue
  fi

  stop_child

  if codex_is_running; then
    log_state_once "no-cdp" "Codex is running without CDP; waiting without restarting or quitting it"
  else
    log_state_once "waiting" "Waiting for Codex to be started by the Taskboard Dock launcher"
  fi

  /bin/sleep 0.5
done
