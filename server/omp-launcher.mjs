import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNS_DIRNAME = "omp-runs";

/**
 * Single-quote a string for safe interpolation into a POSIX shell command.
 * A value is wrapped in '…' with any embedded `'` rewritten as '\'' .
 */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build an AppleScript string literal (double-quoted, with `\` and `"`
 * escaped). AppleScript does NOT accept single-quoted strings, so the shell
 * command passed to `do script` must be wrapped in double quotes here.
 */
function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve the omp executable to an absolute path. We avoid relying on the
 * user's interactive shell function (it is defined in .zshrc and unavailable to
 * a non-interactive runner script), so the absolute binary path is required.
 */
function resolveOmpBinary(candidate) {
  if (candidate && candidate !== "omp" && candidate !== "ohmypi") {
    return path.resolve(candidate);
  }
  const which = spawnSync("/usr/bin/which", ["omp"], { encoding: "utf8" });
  if (which.status === 0) {
    const located = which.stdout.trim().split("\n")[0].trim();
    if (located) return located;
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "omp");
  if (existsSync(fallback)) return fallback;
  return "omp";
}

function connectorEnvLines(connector, tokenEnvVar) {
  if (!connector) return [];
  const lines = [];
  if (connector.baseUrl) {
    lines.push(`export ANTHROPIC_BASE_URL=${shellSingleQuote(connector.baseUrl)}`);
  }
  if (connector.apiKey) {
    lines.push(`export ${tokenEnvVar}=${shellSingleQuote(connector.apiKey)}`);
  }
  if (connector.customHeaders && Object.keys(connector.customHeaders).length > 0) {
    lines.push(`export ANTHROPIC_CUSTOM_HEADERS=${shellSingleQuote(JSON.stringify(connector.customHeaders))}`);
  }
  return lines;
}

function connectorModelFlag(connector) {
  return connector?.model ? ` --model=${shellSingleQuote(connector.model)}` : "";
}

function resolveRuntimeBinary(connector, fallbackBinary) {
  if (connector?.executable) {
    return path.resolve(connector.executable);
  }
  return fallbackBinary;
}

export function createOmpLauncher(options = {}) {
  const dataDirectory = options.dataDirectory;
  if (!dataDirectory) throw new Error("createOmpLauncher requires dataDirectory");
  const runsDirectory = path.join(dataDirectory, RUNS_DIRNAME);
  const ompBinary = resolveOmpBinary(options.ompExecutable);
  let supportedPlatform = process.platform === "darwin";

  function ensureRunsDirectory() {
    mkdirSync(runsDirectory, { recursive: true });
  }

  function sessionDirFor(sessionId) {
    return path.join(runsDirectory, `${sessionId}.session`);
  }

  function assertSupported() {
    if (!supportedPlatform) {
      throw new Error("OMP runtime launcher is only supported on macOS (Terminal.app).");
    }
  }

  function writeSessionFiles(sessionId, payload) {
    ensureRunsDirectory();
    const scriptPath = path.join(runsDirectory, `${sessionId}.sh`);
    const promptPath = path.join(runsDirectory, `${sessionId}.prompt`);
    writeFileSync(promptPath, payload.prompt, { encoding: "utf8" });
    const sessionDir = sessionDirFor(sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const binary = resolveRuntimeBinary(payload.connector, ompBinary);
    const modelFlag = connectorModelFlag(payload.connector);

    const lines = [
      "#!/bin/zsh -l",
      "# taskboard-managed Oh My Pi session launcher",
      "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\"",
      "[ -f \"$HOME/.zprofile\" ] && source \"$HOME/.zprofile\" 2>/dev/null",
      `export CODEX_THREAD_ID=${shellSingleQuote(sessionId)}`,
      `export TASKBOARD_AGENT_RUNTIME='omp'`,
      ...connectorEnvLines(payload.connector, "ANTHROPIC_API_KEY"),
      `cd -- ${shellSingleQuote(payload.workspacePath)}`,
      `${shellSingleQuote(binary)} --auto-approve${modelFlag} --session-dir=${shellSingleQuote(sessionDir)} "$(cat ${shellSingleQuote(promptPath)})"`,
      'echo "\\n[Oh My Pi 会话已退出，可关闭此窗口或重新运行。]"',
      "",
    ];
    writeFileSync(scriptPath, lines.join("\n"), { encoding: "utf8", mode: 0o755 });
    return { scriptPath, promptPath, sessionDir };
  }

  /**
   * Launch a brand-new Oh My Pi session in a fresh Terminal.app window.
   * The session id is fixed via CODEX_THREAD_ID; OMP's own session state
   * is isolated into a per-session directory under the data runs folder.
   */
  function launchSession({ workspacePath, sessionId, prompt, connector }) {
    assertSupported();
    if (!workspacePath || !path.isAbsolute(workspacePath)) {
      throw new Error("workspacePath must be an absolute path");
    }
    if (!sessionId) throw new Error("sessionId is required");
    const { scriptPath } = writeSessionFiles(sessionId, { workspacePath, prompt, connector });
    const appleScript = `tell application "Terminal"
  activate
  do script ${appleScriptString(shellSingleQuote(scriptPath))}
end tell`;
    const result = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8" });
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || "osascript failed").trim();
      throw new Error(`Failed to open Terminal.app for OMP session: ${message}`);
    }
    return { sessionId, scriptPath };
  }

  /**
   * Reopen (and optionally inject a follow-up instruction into) an existing
   * Oh My Pi session by id. OMP uses --continue to resume the last session
   * stored in the per-session directory.
   */
  function resumeSession({ workspacePath, sessionId, followUp, connector }) {
    assertSupported();
    if (!workspacePath || !path.isAbsolute(workspacePath)) {
      throw new Error("workspacePath must be an absolute path");
    }
    if (!sessionId) throw new Error("sessionId is required");
    // If a Terminal window is already running this session, just pop it to the
    // front instead of opening a new window.
    const ttys = findSessionTtys(sessionId);
    if (ttys.length > 0 && focusTerminalForTty(ttys)) {
      return { sessionId, focused: true };
    }
    const hasFollowUp = typeof followUp === "string" && followUp.trim().length > 0;
    ensureRunsDirectory();
    const scriptPath = path.join(runsDirectory, `resume-${sessionId}.sh`);
    const sessionDir = sessionDirFor(sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const promptArg = hasFollowUp ? ` "$(cat ${shellSingleQuote(writeFollowUpFile(sessionId, followUp))})"` : "";
    const binary = resolveRuntimeBinary(connector, ompBinary);
    const modelFlag = connectorModelFlag(connector);
    const lines = [
      "#!/bin/zsh -l",
      "# taskboard-managed Oh My Pi resume launcher",
      "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\"",
      "[ -f \"$HOME/.zprofile\" ] && source \"$HOME/.zprofile\" 2>/dev/null",
      `export CODEX_THREAD_ID=${shellSingleQuote(sessionId)}`,
      `export TASKBOARD_AGENT_RUNTIME='omp'`,
      ...connectorEnvLines(connector, "ANTHROPIC_API_KEY"),
      `cd -- ${shellSingleQuote(workspacePath)}`,
      `${shellSingleQuote(binary)} --auto-approve${modelFlag} --session-dir=${shellSingleQuote(sessionDir)} --continue${promptArg}`,
      'echo "\\n[Oh My Pi 会话已退出，可关闭此窗口或重新运行。]"',
      "",
    ];
    writeFileSync(scriptPath, lines.join("\n"), { encoding: "utf8", mode: 0o755 });
    const appleScript = `tell application "Terminal"
  activate
  do script ${appleScriptString(shellSingleQuote(scriptPath))}
end tell`;
    const result = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8" });
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || "osascript failed").trim();
      throw new Error(`Failed to open Terminal.app for OMP resume: ${message}`);
    }
    return { sessionId, scriptPath };
  }

  function writeFollowUpFile(sessionId, followUp) {
    const followUpPath = path.join(runsDirectory, `resume-${sessionId}.prompt`);
    writeFileSync(followUpPath, followUp, { encoding: "utf8" });
    return followUpPath;
  }

  /**
   * Detect whether an Oh My Pi process is still running with this session id.
   * OMP doesn't have a --session-id flag, so we detect the per-session
   * directory path in the process command line.
   */
  function isRunning(sessionId) {
    if (!sessionId) return false;
    const sessionDir = sessionDirFor(sessionId);
    const result = spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) return false;
    return result.stdout.split("\n").some((line) =>
      line.includes(sessionDir) && /(^|\/)omp\b/.test(line)
    );
  }

  /**
   * Collect the controlling tty devices of every live Oh My Pi process
   * running this session. Each returned value is normalized to the
   * /dev/ttysNNN form that Terminal.app reports on its tabs.
   */
  function findSessionTtys(sessionId) {
    if (!sessionId) return [];
    const sessionDir = sessionDirFor(sessionId);
    const result = spawnSync("/bin/ps", ["-axo", "tty=,command="], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) return [];
    const ttys = new Set();
    for (const line of result.stdout.split("\n")) {
      if (!line.includes(sessionDir)) continue;
      if (!/(^|\/)omp\b/.test(line)) continue;
      const raw = line.trim().split(/\s+/)[0];
      if (!raw || raw === "?" || raw === "??") continue;
      ttys.add(raw.startsWith("/dev/") ? raw : `/dev/${raw.replace(/^\/?dev\//, "")}`);
    }
    return [...ttys];
  }

  /**
   * Bring the Terminal.app window (and tab) that owns one of the given tty
   * devices to the front instead of opening a new window. Returns true when a
   * matching window was found and activated.
   */
  function focusTerminalForTty(ttyList) {
    if (!ttyList.length) return false;
    const listScript = `tell application "Terminal"
  set output to ""
  set i to 0
  repeat with w in windows
    set i to i + 1
    set j to 0
    repeat with t in tabs of w
      set j to j + 1
      set output to output & i & "," & j & "," & (tty of t) & linefeed
    end repeat
  end repeat
  return output
end tell`;
    const listResult = spawnSync("osascript", ["-e", listScript], { encoding: "utf8" });
    if (listResult.status !== 0 || !listResult.stdout) return false;
    const target = new Set(ttyList);
    let match = null;
    for (const line of listResult.stdout.split("\n")) {
      const [windowIndex, tabIndex, tty] = line.split(",");
      if (tty && target.has(tty)) {
        match = { windowIndex: Number(windowIndex), tabIndex: Number(tabIndex) };
        break;
      }
    }
    if (!match) return false;
    const focusScript = `tell application "Terminal"
  activate
  set index of window ${match.windowIndex} to 1
  try
    set selected of tab ${match.tabIndex} of window ${match.windowIndex} to true
  end try
end tell`;
    const focusResult = spawnSync("osascript", ["-e", focusScript], { encoding: "utf8" });
    return focusResult.status === 0;
  }

  /**
   * Best-effort cleanup of stale runner artifacts. Non-fatal.
   */
  function pruneSessionFiles(sessionId) {
    for (const file of [`${sessionId}.sh`, `${sessionId}.prompt`, `resume-${sessionId}.sh`, `resume-${sessionId}.prompt`]) {
      const full = path.join(runsDirectory, file);
      try { rmSync(full, { force: true }); } catch { /* ignore */ }
    }
    try { rmSync(sessionDirFor(sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return {
    launchSession,
    resumeSession,
    isRunning,
    pruneSessionFiles,
    writeSessionFiles,
    get supportedPlatform() { return supportedPlatform; },
  };
}
