import type { IssueDraft } from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";

interface DraftBoxProps {
  drafts: IssueDraft[];
  projectNames: Record<string, string>;
  scopeName: string;
  onCreate: () => void;
  onEdit: (draft: IssueDraft) => void;
  onDelete: (draft: IssueDraft) => void;
}

function updatedLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function DraftBox({
  drafts,
  projectNames,
  scopeName,
  onCreate,
  onEdit,
  onDelete,
}: DraftBoxProps) {
  return (
    <section className="draft-box" aria-labelledby="draft-box-title">
      <header className="draft-box-heading">
        <div>
          <span>{scopeName}</span>
          <h1 id="draft-box-title">草稿箱</h1>
          <p>保存尚未想完整的议题，准备好后再发布。</p>
        </div>
        <button className="button primary" type="button" onClick={onCreate}>
          <LinearIcon name="plus" /> 新建草稿
        </button>
      </header>

      {drafts.length > 0 ? (
        <div className="draft-grid">
          {drafts.map((draft) => (
            <article className="draft-card" key={draft.id}>
              <button className="draft-card-open" type="button" onClick={() => onEdit(draft)}>
                <span className={`status-icon status-icon-${STATUS_DETAILS[draft.content.status].tone}`}>
                  <LinearStatusIcon status={draft.content.status} />
                </span>
                <span className="draft-card-copy">
                  <strong>{draft.content.title || "无标题草稿"}</strong>
                  <span>{projectNames[draft.projectId] ?? "未知项目"} · {STATUS_DETAILS[draft.content.status].label}</span>
                  {draft.content.description && <p>{draft.content.description}</p>}
                </span>
              </button>
              <footer>
                <time dateTime={draft.updatedAt}>更新于 {updatedLabel(draft.updatedAt)}</time>
                <button type="button" onClick={() => onDelete(draft)}>删除</button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="draft-empty">
          <span aria-hidden="true"><LinearIcon name="createIssue" /></span>
          <h2>暂无草稿</h2>
          <p>新建议题时选择“保存到草稿箱”，内容会出现在这里。</p>
        </div>
      )}
    </section>
  );
}
