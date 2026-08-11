#!/bin/zsh
set -uo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
injector="$script_dir/codex-injector.mjs"
codex_app="/Applications/ChatGPT.app"
codex_executable="$codex_app/Contents/MacOS/ChatGPT"
cdp_port="9229"
cdp_version_url="http://127.0.0.1:${cdp_port}/json/version"
log_file="$project_root/.data/codex-taskboard-launcher.log"
node_path_file="$project_root/.data/node-path"
codex_path_file="$project_root/.data/codex-path"

/bin/mkdir -p "$project_root/.data"

log() {
  /bin/echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*" >> "$log_file"
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

cdp_is_ready() {
  /usr/bin/curl -fsS --max-time 1 "$cdp_version_url" >/dev/null 2>&1
}

inject_current_codex() {
  log "Injecting Taskboard into the current Codex renderer"
  if "$node_binary" "$injector" --port "$cdp_port" --open --attach-existing >> "$log_file" 2>&1; then
    log "Taskboard injection completed"
    return 0
  fi
  log "Taskboard injection failed"
  return 1
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

if [[ ! -d "$codex_app" ]]; then
  log "Codex app not found at $codex_app"
  exit 1
fi

if cdp_is_ready; then
  log "Codex CDP is already ready; restoring Taskboard before focusing the app"
  inject_current_codex
  /usr/bin/open -a "$codex_app"
  exit 0
fi

if codex_is_running; then
  log "Codex is already running without CDP; leaving the current session untouched"
  /usr/bin/open -a "$codex_app"
  exit 2
fi

log "Starting Codex with loopback-only CDP on port $cdp_port"
/usr/bin/open -a "$codex_app" --args \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$cdp_port" \
  "--remote-allow-origins=http://127.0.0.1:${cdp_port}" \
  "--disable-features=LocalNetworkAccessChecks"

for _ in {1..60}; do
  if cdp_is_ready; then
    log "Codex CDP became ready"
    inject_current_codex
    exit 0
  fi
  /bin/sleep 0.5
done

log "Codex started but CDP did not become ready within 30 seconds"
exit 1
