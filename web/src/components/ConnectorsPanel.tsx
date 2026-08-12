import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Connector, ConnectorDraft, ConnectorRuntime } from "../types";
import * as api from "../api";

interface ConnectorsPanelProps {
  connectors: Connector[];
  onChanged: () => void;
  onClose: () => void;
}

const RUNTIMES: ConnectorRuntime[] = ["claude", "omp"];

const RUNTIME_LABEL: Record<ConnectorRuntime, string> = {
  claude: "Claude Code",
  omp: "Oh My Pi",
};

function emptyDraft(runtime: ConnectorRuntime): ConnectorDraft {
  return {
    name: "",
    runtime,
    baseUrl: null,
    apiKey: null,
    model: null,
    customHeaders: null,
    executable: null,
    isDefault: false,
  };
}

interface EditState {
  id: string | null;
  version: number | null;
  draft: ConnectorDraft;
}

export function ConnectorsPanel({ connectors, onChanged, onClose }: ConnectorsPanelProps) {
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function startCreate(runtime: ConnectorRuntime) {
    setEditing({ id: null, version: null, draft: emptyDraft(runtime) });
  }

  function startEdit(connector: Connector) {
    setEditing({
      id: connector.id,
      version: connector.version,
      draft: {
        name: connector.name,
        runtime: connector.runtime,
        baseUrl: connector.baseUrl,
        apiKey: connector.apiKey,
        model: connector.model,
        customHeaders: connector.customHeaders,
        executable: connector.executable,
        isDefault: connector.isDefault,
      },
    });
  }

  async function save(data: ConnectorDraft) {
    await run(async () => {
      if (editing?.id && editing.version != null) {
        const { runtime: _runtime, ...changes } = data;
        void _runtime;
        await api.updateConnector(
          { id: editing.id, version: editing.version, runtime: data.runtime } as Connector,
          changes,
        );
      } else {
        await api.createConnector(data);
      }
    });
  }

  return createPortal(
    <div className="connectors-overlay" onClick={onClose} role="presentation">
      <div
        className="connectors-panel"
        role="dialog"
        aria-label="运行时连接器配置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="connectors-header">
          <h2>运行时连接器</h2>
          <button type="button" className="connectors-close" onClick={onClose} aria-label="关闭">关闭</button>
        </header>
        <p className="connectors-intro">
          每个渠道可保存一组 baseUrl / apiKey / model。Claude 与 OMP 启动会话时自动取对应渠道的默认连接器注入；未配置则回落到环境变量。
        </p>
        {error && <div className="connectors-error">{error}</div>}
        <div className="connectors-body">
          {RUNTIMES.map((runtime) => {
            const list = connectors.filter((connector) => connector.runtime === runtime);
            return (
              <section key={runtime} className="connectors-group">
                <div className="connectors-group-heading">
                  <span>{RUNTIME_LABEL[runtime]}</span>
                  <button
                    type="button"
                    className="connectors-add"
                    onClick={() => startCreate(runtime)}
                  >
                    + 新增
                  </button>
                </div>
                {list.length === 0 && (
                  <p className="connectors-empty">
                    尚未配置 {RUNTIME_LABEL[runtime]} 连接器，启动将回落到环境变量。
                  </p>
                )}
                <ul className="connectors-list">
                  {list.map((connector) => (
                    <li
                      key={connector.id}
                      className={`connectors-item${connector.isDefault ? " is-default" : ""}`}
                    >
                      <div className="connectors-item-main">
                        <span className="connectors-name">
                          {connector.name}
                          {connector.isDefault && <em>默认</em>}
                        </span>
                        <span className="connectors-meta">
                          {connector.model ?? "（未指定 model）"} · {connector.baseUrl ?? "（未指定 baseUrl）"}
                        </span>
                      </div>
                      <div className="connectors-item-actions">
                        <button
                          type="button"
                          disabled={busy || connector.isDefault}
                          onClick={() => run(async () => { await api.setDefaultConnector(connector); })}
                        >
                          设为默认
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => startEdit(connector)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="connectors-danger"
                          onClick={() => run(async () => { await api.deleteConnector(connector); })}
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        {editing && (
          <ConnectorEditor
            draft={editing.draft}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ConnectorEditorProps {
  draft: ConnectorDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ConnectorDraft) => Promise<void>;
}

function ConnectorEditor({ draft, busy, onCancel, onSave }: ConnectorEditorProps) {
  const [name, setName] = useState(draft.name);
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(draft.apiKey ?? "");
  const [model, setModel] = useState(draft.model ?? "");
  const [executable, setExecutable] = useState(draft.executable ?? "");
  const [customHeadersText, setCustomHeadersText] = useState(
    draft.customHeaders ? JSON.stringify(draft.customHeaders) : "",
  );
  const [isDefault, setIsDefault] = useState(draft.isDefault ?? false);
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    let customHeaders: Record<string, string> | null = null;
    const trimmed = customHeadersText.trim();
    if (trimmed) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          customHeaders = parsed as Record<string, string>;
        } else {
          setLocalError("customHeaders 必须是 JSON 对象");
          return;
        }
      } catch {
        setLocalError("customHeaders 不是合法 JSON");
        return;
      }
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError("名称不能为空");
      return;
    }
    setLocalError(null);
    void onSave({
      name: trimmedName,
      runtime: draft.runtime,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey || null,
      model: model.trim() || null,
      executable: executable.trim() || null,
      customHeaders,
      isDefault,
    });
  }

  return createPortal(
    <div className="connectors-overlay" role="presentation">
      <div className="connectors-editor" role="dialog" aria-label={`${RUNTIME_LABEL[draft.runtime]} 连接器编辑`}>
        <form onSubmit={submit}>
          <header className="connectors-header">
            <h2>{RUNTIME_LABEL[draft.runtime]} 连接器</h2>
          </header>
          {localError && <div className="connectors-error">{localError}</div>}
          <label className="connectors-field">
            <span>名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="如：glm 代理 / anthropic 官方" />
          </label>
          <label className="connectors-field">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} maxLength={2048} placeholder="https://api.anthropic.com" />
          </label>
          <label className="connectors-field">
            <span>API Key / Token</span>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} maxLength={512} placeholder="sk-...（Claude 用 AUTH_TOKEN，OMP 用 API_KEY）" type="password" />
          </label>
          <label className="connectors-field">
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} placeholder="如 glm-5.2 / opus / claude-sonnet-5" />
          </label>
          <label className="connectors-field">
            <span>可执行文件（可选）</span>
            <input value={executable} onChange={(e) => setExecutable(e.target.value)} maxLength={4096} placeholder="留空则自动探测 claude / omp" />
          </label>
          <label className="connectors-field">
            <span>自定义 Headers（JSON，可选）</span>
            <textarea value={customHeadersText} onChange={(e) => setCustomHeadersText(e.target.value)} rows={2} placeholder='{"user-id":"USERNAME"}' />
          </label>
          <label className="connectors-checkbox">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span>设为该渠道默认</span>
          </label>
          <div className="connectors-editor-actions">
            <button type="button" onClick={onCancel} disabled={busy}>取消</button>
            <button type="submit" disabled={busy}>保存</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
