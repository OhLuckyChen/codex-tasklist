import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectBotConfig, ProjectBotDraft, TaskRuntime } from "../types";
import * as api from "../api";
import { LinearIcon } from "./LinearIcon";
import { RuntimeIcon } from "./RuntimeIcon";

interface ProjectBotsPanelProps {
  projectId: string;
  projectName: string;
  workspacePath: string;
  onClose?: () => void;
}

const RUNTIMES: TaskRuntime[] = ["codex", "claude", "omp"];

const RUNTIME_LABELS: Record<TaskRuntime, string> = {
  codex: "Codex",
  claude: "Claude Code",
  omp: "Oh My Pi",
};

const CONNECTION_LABELS: Record<ProjectBotConfig["connectionStatus"], string> = {
  disabled: "未启用",
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  error: "连接异常",
};

function emptyDraft(workspacePath: string): ProjectBotDraft {
  return {
    botId: "",
    secret: "",
    enabled: false,
    runtime: "codex",
    workspacePath,
    knowledgeEnabled: true,
    codeSearchEnabled: true,
  };
}

export function ProjectBotsPanel({ projectId, projectName, workspacePath, onClose }: ProjectBotsPanelProps) {
  const [bots, setBots] = useState<ProjectBotConfig[]>([]);
  const [editing, setEditing] = useState<{ bot: ProjectBotConfig | null; draft: ProjectBotDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.listProjectBots(projectId, controller.signal)
      .then(setBots)
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    if (!onClose) return undefined;
    const close: () => void = onClose;
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [onClose]);

  async function reload() {
    setBots(await api.listProjectBots(projectId));
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(bot: ProjectBotConfig) {
    setEditing({
      bot,
      draft: {
        botId: bot.botId,
        secret: "",
        enabled: bot.enabled,
        runtime: bot.runtime,
        workspacePath: bot.workspacePath,
        knowledgeEnabled: bot.knowledgeEnabled,
        codeSearchEnabled: bot.codeSearchEnabled,
      },
    });
  }

  const panelContent = (
    <div
      className="connectors-panel project-bots-panel"
      role="dialog"
      aria-label="企微机器人配置"
      onClick={(event) => event.stopPropagation()}
    >
      <header className="connectors-header">
        <h2>{projectName} · 企微机器人</h2>
        {onClose && <button type="button" className="connectors-close" onClick={onClose} aria-label="关闭">关闭</button>}
      </header>
      <p className="connectors-intro">
        BotID 路由到当前项目；Secret 加密存储，保存后不回显。workspacePath 是知识库与代码只读检索边界。
      </p>
      {error && <div className="connectors-error">{error}</div>}
      <div className="connectors-body">
        <section className="connectors-group">
          <div className="connectors-group-heading">
            <span>机器人配置</span>
            <button
              type="button"
              className="connectors-add"
              disabled={busy}
              onClick={() => setEditing({ bot: null, draft: emptyDraft(workspacePath) })}
            >
              + 新增
            </button>
          </div>
          {bots.length === 0 && <p className="connectors-empty">尚未配置企微机器人。</p>}
          <ul className="connectors-list">
            {bots.map((bot) => (
              <li key={bot.id} className={`connectors-item${bot.enabled ? " is-default" : ""}`}>
                <div className="connectors-item-main">
                  <span className="connectors-name">
                    {bot.botId}
                    {bot.enabled && <em>启用</em>}
                  </span>
                  <span className="connectors-meta">
                    {RUNTIME_LABELS[bot.runtime]} · {CONNECTION_LABELS[bot.connectionStatus]} · {bot.workspacePath}
                    {bot.lastError ? ` · ${bot.lastError}` : ""}
                  </span>
                </div>
                <div className="connectors-item-actions">
                  <button
                    type="button"
                    disabled={busy || bot.connectionStatus === "connecting"}
                    onClick={() => run(async () => {
                      await (bot.connectionStatus === "connected"
                        ? api.disconnectProjectBot(bot)
                        : api.connectProjectBot(bot));
                    })}
                  >
                    {bot.connectionStatus === "connected"
                      ? "断开"
                      : bot.connectionStatus === "connecting" ? "连接中" : "连接"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => startEdit(bot)}>编辑</button>
                  <button
                    type="button"
                    disabled={busy}
                    className="connectors-danger"
                    onClick={() => run(async () => { await api.deleteProjectBot(bot); })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {editing && (
        <ProjectBotEditor
          draft={editing.draft}
          editing={Boolean(editing.bot)}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(draft) => run(async () => {
            if (editing.bot) {
              const changes = { ...draft };
              if (!changes.secret?.trim()) delete changes.secret;
              await api.updateProjectBot(editing.bot, changes);
            } else {
              await api.createProjectBot(projectId, draft);
            }
          })}
        />
      )}
    </div>
  );
  if (onClose) {
    return createPortal(
      <div className="connectors-overlay" onClick={onClose} role="presentation">
        {panelContent}
      </div>,
      document.body,
    );
  }
  return (
    <section className="project-bots-page">
      {panelContent}
    </section>
  );
}

interface ProjectBotEditorProps {
  draft: ProjectBotDraft;
  editing: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ProjectBotDraft) => Promise<void>;
}

function ProjectBotEditor({ draft, editing, busy, onCancel, onSave }: ProjectBotEditorProps) {
  const [botId, setBotId] = useState(draft.botId);
  const [secret, setSecret] = useState(draft.secret ?? "");
  const [enabled, setEnabled] = useState(Boolean(draft.enabled));
  const [runtime, setRuntime] = useState<TaskRuntime>(draft.runtime);
  const [workspacePath, setWorkspacePath] = useState(draft.workspacePath);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(draft.knowledgeEnabled !== false);
  const [codeSearchEnabled, setCodeSearchEnabled] = useState(draft.codeSearchEnabled !== false);
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!botId.trim()) {
      setLocalError("BotID 不能为空");
      return;
    }
    if (!editing && !secret.trim()) {
      setLocalError("Secret 不能为空");
      return;
    }
    if (!workspacePath.trim()) {
      setLocalError("workspacePath 不能为空");
      return;
    }
    setLocalError(null);
    void onSave({
      botId: botId.trim(),
      secret: secret || undefined,
      enabled,
      runtime,
      workspacePath: workspacePath.trim(),
      knowledgeEnabled,
      codeSearchEnabled,
    });
  }

  return createPortal(
    <div className="connectors-overlay" role="presentation">
      <div className="connectors-editor" role="dialog" aria-label="编辑企微机器人">
        <form onSubmit={submit}>
          <header className="connectors-header">
            <h2>企微机器人</h2>
          </header>
          {localError && <div className="connectors-error">{localError}</div>}
          <label className="connectors-field">
            <span>BotID</span>
            <input value={botId} maxLength={128} disabled={busy} onChange={(event) => setBotId(event.target.value)} />
          </label>
          <label className="connectors-field">
            <span>Secret</span>
            <input
              value={secret}
              maxLength={2048}
              type="password"
              placeholder={editing ? "留空则保持不变" : ""}
              disabled={busy}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <label className="connectors-field">
            <span>workspacePath</span>
            <input value={workspacePath} maxLength={4096} disabled={busy} onChange={(event) => setWorkspacePath(event.target.value)} />
          </label>
          <label className="connectors-field">
            <span>后端运行时</span>
            <select value={runtime} disabled={busy} onChange={(event) => setRuntime(event.target.value as TaskRuntime)}>
              {RUNTIMES.map((item) => (
                <option key={item} value={item}>{RUNTIME_LABELS[item]}</option>
              ))}
            </select>
          </label>
          <div className="project-bot-switches">
            <button type="button" className={`board-setting-switch${enabled ? " is-on" : ""}`} role="switch" aria-checked={enabled} onClick={() => setEnabled((current) => !current)}>
              <span aria-hidden="true" />
            </button>
            <span><RuntimeIcon runtime={runtime} /> 启用机器人</span>
            <button type="button" className={`board-setting-switch${knowledgeEnabled ? " is-on" : ""}`} role="switch" aria-checked={knowledgeEnabled} onClick={() => setKnowledgeEnabled((current) => !current)}>
              <span aria-hidden="true" />
            </button>
            <span><LinearIcon name="file" /> 项目知识库</span>
            <button type="button" className={`board-setting-switch${codeSearchEnabled ? " is-on" : ""}`} role="switch" aria-checked={codeSearchEnabled} onClick={() => setCodeSearchEnabled((current) => !current)}>
              <span aria-hidden="true" />
            </button>
            <span><LinearIcon name="search" /> 代码只读检索</span>
          </div>
          <footer className="connectors-editor-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
