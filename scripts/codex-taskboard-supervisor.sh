#!/bin/zsh
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CODEX_TASKBOARD_HOST="127.0.0.1"
export CODEX_TASKBOARD_PORT="47823"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
injector="$script_dir/codex-injector.mjs"
node_binary="/opt/homebrew/bin/node"
codex_app="/Applications/ChatGPT.app"
codex_bundle_id="com.openai.codex"
cdp_port="9229"
cdp_version_url="http://127.0.0.1:${cdp_port}/json/version"
defer_file="$project_root/.data/codex-taskboard-supervisor.defer-pid"
child_pid=""

log() {
  /bin/echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*"
}

cdp_is_ready() {
  /usr/bin/curl -fsS --max-time 1 "$cdp_version_url" >/dev/null 2>&1
}

codex_pid() {
  /bin/ps -axo pid=,command= \
    | /usr/bin/awk -v expected="$codex_app/Contents/MacOS/ChatGPT" '
      {
        pid = $1
        sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
        if ($0 == expected) {
          print pid
          exit
        }
      }
    '
}

pid_is_codex() {
  local target_pid="$1"
  [[ "$target_pid" == <-> ]] || return 1
  /bin/ps -p "$target_pid" -o command= 2>/dev/null \
    | /usr/bin/grep -Fq "$codex_app/Contents/MacOS/ChatGPT"
}

wait_for_pid_exit() {
  local target_pid="$1"
  while pid_is_codex "$target_pid"; do
    /bin/sleep 0.5
  done
}

stop_child() {
  if [[ -n "$child_pid" ]] && /bin/kill -0 "$child_pid" 2>/dev/null; then
    /bin/kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=""
}

shutdown() {
  stop_child
  exit 0
}

trap shutdown INT TERM HUP

cd "$project_root" || exit 1

if [[ -f "$defer_file" ]]; then
  deferred_pid="$(/bin/cat "$defer_file" 2>/dev/null || true)"
  if pid_is_codex "$deferred_pid"; then
    log "Keeping the current Codex session untouched (pid $deferred_pid)"
    wait_for_pid_exit "$deferred_pid"
  fi
  /bin/rm -f "$defer_file"
fi

log "Codex Taskboard supervisor started"

while true; do
  if cdp_is_ready; then
    log "Attaching Taskboard injector to Codex CDP port $cdp_port"
    "$node_binary" "$injector" --port "$cdp_port" --watch --open &
    child_pid="$!"
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
    /bin/sleep 1
    continue
  fi

  current_pid="$(codex_pid)"
  if [[ -z "$current_pid" ]]; then
    /bin/sleep 0.5
    continue
  fi

  log "Codex was opened without CDP; requesting one controlled restart"
  for _ in {1..20}; do
    /usr/bin/osascript -e "tell application id \"$codex_bundle_id\" to quit" >/dev/null 2>&1 || true
    /bin/sleep 0.5
    pid_is_codex "$current_pid" || break
  done

  if pid_is_codex "$current_pid"; then
    log "Codex did not quit automatically; waiting for the user to close it"
    wait_for_pid_exit "$current_pid"
  fi
  while [[ -n "$(codex_pid)" ]]; do
    /bin/sleep 0.5
  done

  log "Launching Codex with CDP and Taskboard injection"
  "$node_binary" "$injector" \
    --port "$cdp_port" \
    --app-path "$codex_app" \
    --launch \
    --watch \
    --open &
  child_pid="$!"
  wait "$child_pid" 2>/dev/null || true
  child_pid=""
  /bin/sleep 1
done
