#!/bin/zsh
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
launcher_app="$project_root/macos/Codex Taskboard.app"
launcher_url="file://${launcher_app// /%20}/"
launch_agent_label="com.lincya.codex-taskboard.supervisor"
launch_agent_template="$project_root/macos/${launch_agent_label}.plist"
launch_agent="$HOME/Library/LaunchAgents/${launch_agent_label}.plist"
dock_backup="$project_root/.data/com.apple.dock.before-codex-taskboard.plist"
dock_work="$(/usr/bin/mktemp /tmp/codex-taskboard-dock.XXXXXX)"
user_id="$(/usr/bin/id -u)"

if [[ ! -d "$launcher_app" ]]; then
  /bin/echo "Launcher app not found: $launcher_app" >&2
  exit 1
fi

/bin/mkdir -p "$project_root/.data" "$HOME/Library/LaunchAgents"
/bin/chmod +x \
  "$project_root/scripts/codex-taskboard-launcher.sh" \
  "$project_root/scripts/codex-taskboard-supervisor.sh" \
  "$launcher_app/Contents/MacOS/codex-taskboard"

/bin/cp "$launch_agent_template" "$launch_agent"
/usr/bin/plutil -replace ProgramArguments -json \
  "[\"/bin/zsh\",\"$project_root/scripts/codex-taskboard-supervisor.sh\"]" "$launch_agent"
/usr/bin/plutil -replace StandardOutPath -string \
  "$project_root/.data/codex-taskboard-supervisor.log" "$launch_agent"
/usr/bin/plutil -replace StandardErrorPath -string \
  "$project_root/.data/codex-taskboard-supervisor.error.log" "$launch_agent"
/usr/bin/plutil -lint "$launch_agent"

/bin/launchctl bootout "gui/${user_id}" "$launch_agent" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/${user_id}" "$launch_agent"
/bin/launchctl kickstart -k "gui/${user_id}/${launch_agent_label}"

if [[ ! -f "$dock_backup" ]]; then
  /usr/bin/defaults export com.apple.dock "$dock_backup" >/dev/null
fi
/usr/bin/defaults export com.apple.dock "$dock_work" >/dev/null

typeset -a dock_indices_to_remove
index=0
while /usr/libexec/PlistBuddy -c "Print :persistent-apps:${index}" "$dock_work" >/dev/null 2>&1; do
  bundle_id="$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:${index}:tile-data:bundle-identifier" "$dock_work" 2>/dev/null || true)"
  file_url="$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:${index}:tile-data:file-data:_CFURLString" "$dock_work" 2>/dev/null || true)"
  if [[ "$bundle_id" == "com.openai.codex" || "$file_url" == "$launcher_url" ]]; then
    dock_indices_to_remove+=("$index")
  fi
  (( index += 1 ))
done

for (( position = ${#dock_indices_to_remove[@]}; position >= 1; position -= 1 )); do
  /usr/libexec/PlistBuddy -c \
    "Delete :persistent-apps:${dock_indices_to_remove[$position]}" "$dock_work"
done

app_count=0
while /usr/libexec/PlistBuddy -c "Print :persistent-apps:${app_count}" "$dock_work" >/dev/null 2>&1; do
  (( app_count += 1 ))
done

/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count} dict" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-type string file-tile" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data dict" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data:file-label string Codex Taskboard" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data:bundle-identifier string com.lincya.codex-taskboard.launcher" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data:file-data dict" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data:file-data:_CFURLString string $launcher_url" "$dock_work"
/usr/libexec/PlistBuddy -c "Add :persistent-apps:${app_count}:tile-data:file-data:_CFURLStringType integer 15" "$dock_work"
/usr/bin/plutil -lint "$dock_work"
/usr/bin/defaults import com.apple.dock "$dock_work"
/usr/bin/killall Dock

/bin/echo "Installed the passive supervisor and replaced the Codex Dock entry."
/bin/echo "Quit the currently running Codex once, then use the Codex Taskboard Dock icon."
