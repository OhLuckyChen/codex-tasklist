import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import * as api from "../api";
import type { AgentTemplate } from "../types";

interface AgentManagerProps {
  projectId?: string;
  projectName?: string;
  onChanged: (agents: AgentTemplate[], projectAgentIds: string[]) => void;
  onClose: () => void;
}

interface AgentDraft {
  name: string;
  templateType: "inline" | "file";
  templateValue: string;
  skillPaths: string[];
}

const EMPTY_DRAFT: AgentDraft = {
  name: "",
  templateType: "inline",
  templateValue: "",
  skillPaths: [],
};

function skillDirectoryName(skillPath: string): string {
  return skillPath.split(/[\\/]/).filter(Boolean).at(-1) ?? skillPath;
}

export function AgentManager({
  projectId,
  projectName,
  onChanged,
  onClose,
}: AgentManagerProps) {
  const [agents, setAgents] = useState<AgentTemplate[]>([]);
  const [projectAgentIds, setProjectAgentIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<AgentTemplate | null | undefined>(undefined);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextProjectAgentIds] = await Promise.all([
        api.listAgentTemplates(),
        projectId ? api.listProjectAgentIds(projectId) : Promise.resolve([]),
      ]);
      setAgents(nextAgents);
      setProjectAgentIds(nextProjectAgentIds);
      onChanged(nextAgents, nextProjectAgentIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function beginCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  function beginEdit(agent: AgentTemplate) {
    setEditing(agent);
    setDraft({
      name: agent.name,
      templateType: agent.templateType,
      templateValue: agent.templateValue,
      skillPaths: agent.skillPaths,
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.templateValue.trim()) {
      setError("请填写 Agent 名称，并输入模板内容或选择模板文件。");
      return;
    }
    await run(async () => {
      const input = {
        ...draft,
        name: draft.name.trim(),
        templateValue: draft.templateValue.trim(),
      };
      if (editing) await api.updateAgentTemplate(editing, input);
      else await api.createAgentTemplate(input);
      setEditing(undefined);
      setDraft(EMPTY_DRAFT);
    });
  }

  async function toggleProjectAgent(agentId: string) {
    if (!projectId) return;
    const next = projectAgentIds.includes(agentId)
      ? projectAgentIds.filter((id) => id !== agentId)
      : [...projectAgentIds, agentId];
    await run(async () => {
      const saved = await api.setProjectAgentIds(projectId, next);
      setProjectAgentIds(saved);
      onChanged(agents, saved);
    });
  }

  async function selectTemplateFile() {
    setBusy(true);
    setError(null);
    try {
      const filePath = await api.chooseAgentTemplateFile();
      if (filePath) setDraft((current) => ({ ...current, templateValue: filePath }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addSkillDirectory() {
    setBusy(true);
    setError(null);
    try {
      const skill = await api.chooseAgentSkillDirectory();
      if (skill) {
        setDraft((current) => ({
          ...current,
          skillPaths: current.skillPaths.includes(skill.directoryPath)
            ? current.skillPaths
            : [...current.skillPaths, skill.directoryPath],
        }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="connectors-overlay" role="presentation" onClick={onClose}>
      <div
        className="connectors-panel agent-manager-panel"
        role="dialog"
        aria-label="Agent 模板管理"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="connectors-header">
          <h2>Agent 模板</h2>
          <button type="button" className="connectors-close" onClick={onClose}>关闭</button>
        </header>
        <p className="connectors-intro">
          {projectId
            ? <>Agent 只保存名称、模板和 Skill。勾选“{projectName} 可用”后，才能在该项目的 Issue 或评论中选择。</>
            : "Agent 只保存名称、模板和 Skill；进入项目后可配置该项目允许使用哪些 Agent。"}
        </p>
        {error && <div className="connectors-error">{error}</div>}
        <div className="connectors-body">
          <div className="connectors-group-heading">
            <span>全部 Agent</span>
            <button type="button" className="connectors-add" onClick={beginCreate}>+ 新增</button>
          </div>
          {loading ? <p className="connectors-empty">正在读取 Agent…</p> : agents.length === 0 ? (
            <p className="connectors-empty">尚未创建 Agent。</p>
          ) : (
            <ul className="connectors-list">
              {agents.map((agent) => (
                <li className="connectors-item" key={agent.id}>
                  <div className="connectors-item-main">
                    <span className="connectors-name">{agent.name}</span>
                    <span className="connectors-meta">
                      {agent.templateType === "inline" ? "手填模板" : agent.templateValue} · {agent.skillPaths.length} 个 Skill
                    </span>
                  </div>
                  {projectId && (
                    <label className="agent-project-toggle">
                      <input
                        type="checkbox"
                        checked={projectAgentIds.includes(agent.id)}
                        disabled={busy}
                        onChange={() => void toggleProjectAgent(agent.id)}
                      />
                      {projectName} 可用
                    </label>
                  )}
                  <div className="connectors-item-actions">
                    <button type="button" disabled={busy} onClick={() => beginEdit(agent)}>编辑</button>
                    <button
                      type="button"
                      className="connectors-danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`确认删除 Agent“${agent.name}”？相关 Issue 和评论会解除绑定。`)) {
                          void run(async () => { await api.deleteAgentTemplate(agent); });
                        }
                      }}
                    >删除</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {editing !== undefined && (
          <form className="agent-editor" onSubmit={(event) => void save(event)}>
            <h3>{editing ? `编辑 ${editing.name}` : "新增 Agent"}</h3>
            <label className="connectors-field">
              <span>名称</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="connectors-field">
              <span>模板来源</span>
              <select
                value={draft.templateType}
                onChange={(event) => setDraft({ ...draft, templateType: event.target.value as AgentDraft["templateType"], templateValue: "" })}
              >
                <option value="inline">手工填写</option>
                <option value="file">本地文件</option>
              </select>
            </label>
            <div className="connectors-field">
              <span>{draft.templateType === "inline" ? "模板内容" : "本地模板文件"}</span>
              {draft.templateType === "inline" ? (
                <textarea rows={7} value={draft.templateValue} onChange={(event) => setDraft({ ...draft, templateValue: event.target.value })} />
              ) : (
                <div className="agent-path-picker">
                  <input readOnly value={draft.templateValue} placeholder="尚未选择模板文件" />
                  <button type="button" disabled={busy} onClick={() => void selectTemplateFile()}>选择文件</button>
                </div>
              )}
            </div>
            <fieldset className="agent-skill-list">
              <legend>关联 Skill</legend>
              <button type="button" className="agent-skill-add" disabled={busy} onClick={() => void addSkillDirectory()}>
                + 选择 Skill 目录
              </button>
              {draft.skillPaths.length === 0 ? <p>尚未选择 Skill 目录。</p> : (
                <ul className="agent-selected-skills">
                  {draft.skillPaths.map((skillPath) => (
                    <li key={skillPath}>
                      <span><strong>{skillDirectoryName(skillPath)}</strong><small>{skillPath}</small></span>
                      <button
                        type="button"
                        aria-label={`移除 ${skillDirectoryName(skillPath)}`}
                        onClick={() => setDraft((current) => ({
                          ...current,
                          skillPaths: current.skillPaths.filter((pathValue) => pathValue !== skillPath),
                        }))}
                      >移除</button>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="connectors-editor-actions">
              <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button>
              <button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
