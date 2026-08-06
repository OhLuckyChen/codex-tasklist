import { useEffect, useRef, useState, type FormEvent } from "react";
import { LinearIcon } from "./LinearIcon";

export interface ProjectCreateDraft {
  name: string;
  workspacePath: string;
}

interface ProjectCreatorProps {
  codexLinkAvailable: boolean;
  submitting: boolean;
  onCancel: () => void;
  onChooseWorkspace: () => Promise<string | null>;
  onSubmit: (draft: ProjectCreateDraft) => Promise<void>;
}

export function ProjectCreator({
  codexLinkAvailable,
  submitting,
  onCancel,
  onChooseWorkspace,
  onSubmit,
}: ProjectCreatorProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    await onSubmit({ name: name.trim(), workspacePath: workspacePath.trim() });
  }

  async function chooseWorkspace() {
    if (submitting || choosingWorkspace) return;
    setChoosingWorkspace(true);
    try {
      const selectedPath = await onChooseWorkspace();
      if (selectedPath) setWorkspacePath(selectedPath);
    } finally {
      setChoosingWorkspace(false);
    }
  }

  return (
    <section className="project-create-panel" aria-labelledby="project-create-heading">
      <div className="project-create-heading">
        <span className="project-create-icon" aria-hidden="true"><LinearIcon name="folder" /></span>
        <div>
          <h2 id="project-create-heading">新增项目</h2>
          <p>{codexLinkAvailable
            ? "添加本地目录后，任务面板会同步注册为 Codex 项目。"
            : "添加本地目录；在 Codex 内打开任务面板时可同步为 Codex 项目。"}</p>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>项目名称</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            maxLength={120}
            placeholder="例如：订单服务"
            disabled={submitting}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>本地项目目录</span>
          <button
            className={`project-directory-picker${workspacePath ? " has-selection" : ""}`}
            type="button"
            disabled={submitting || choosingWorkspace}
            onClick={() => void chooseWorkspace()}
          >
            <LinearIcon name="folder" />
            <span>{workspacePath || (choosingWorkspace ? "正在打开访达…" : "选择文件夹…")}</span>
            <strong>{workspacePath ? "重新选择" : "选择"}</strong>
          </button>
          <small>通过访达选择已有文件夹，用于 Codex 工作区联动。</small>
        </label>
        <div className="project-create-actions">
          <button className="button secondary" type="button" disabled={submitting} onClick={onCancel}>取消</button>
          <button className="button primary" type="submit" disabled={submitting || !name.trim() || !workspacePath.trim()}>
            {submitting ? "正在新增…" : codexLinkAvailable ? "新增并同步 Codex" : "新增项目"}
          </button>
        </div>
      </form>
    </section>
  );
}
