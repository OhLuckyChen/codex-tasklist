import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ApiError,
  askProjectKnowledge,
  checkKnowledge,
  createKnowledgeProposal,
  generateKnowledgeProposal,
  getKnowledgePage,
  getKnowledgeSourceVersions,
  listKnowledgeProposals,
  publishKnowledgeProposal,
  searchKnowledge,
  updateKnowledgeProposal,
} from "../api";
import type {
  DevelopmentScan,
  GeneratedKnowledgeProposal,
  KnowledgeAnswer,
  KnowledgeDevelopmentContext,
  KnowledgeOverview,
  KnowledgePage,
  KnowledgeProposal,
  KnowledgeProposalChange,
  KnowledgeSearchResult,
  KnowledgeSourceType,
  Project,
} from "../types";

type KnowledgeSection = "published" | "pending" | "health";

const SOURCE_LABELS: Record<KnowledgeSourceType, string> = {
  project_scan: "项目分析",
  issue: "Issue 复盘",
  comments: "评论整理",
  question: "项目问答",
  stale_refresh: "过期修订",
  project_review: "项目复盘",
};

const HEALTH_LABELS = {
  fresh: "最新",
  stale: "可能过期",
  unverified: "来源待验证",
  missing_sources: "缺少来源",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "PROJECT_WORKSPACE_REQUIRED") return "请先在项目首页选择本地项目目录。";
    if (error.code === "INVALID_WORKSPACE_CONTEXT") return "当前知识目录与项目目录不一致，请返回项目首页确认本地项目目录。";
    if (error.code === "KNOWLEDGE_ANALYSIS_FAILED") return "项目分析失败，请重试；若持续失败，请检查 Codex 登录状态。";
    if (error.code === "KNOWLEDGE_ANALYSIS_TIMEOUT") return "项目分析超时，请稍后重试。";
    if (error.code === "KNOWLEDGE_ANALYSIS_INVALID") return "项目分析结果格式不正确，请重新初始化。";
    if (error.code === "KNOWLEDGE_WORKSPACE_PERMISSION_DENIED") {
      return "当前后台分析方式无法读取该项目目录，请通过 Codex 项目会话重新分析。";
    }
  }
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function lineDiff(before: string | null, after: string | null) {
  const left = (before ?? "").split("\n");
  const right = (after ?? "").split("\n");
  if (left.length * right.length > 250_000) {
    return [
      ...left.map((text) => ({ type: "remove" as const, text })),
      ...right.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const rows: Array<{ type: "same" | "add" | "remove"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ type: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      rows.push({ type: "add", text: right[j] });
      j += 1;
    } else {
      rows.push({ type: "remove", text: left[i] });
      i += 1;
    }
  }
  return rows;
}

function proposalWorkspace(
  proposal: KnowledgeProposal,
  fallback: string | null,
  scan: DevelopmentScan,
): string | undefined {
  if (proposal.developmentContext?.type === "worktree") {
    const match = scan.contexts.find((context) => (
      context.type === "worktree" && context.branch === proposal.developmentContext?.branch
    ));
    if (match?.type === "worktree") return match.path;
  }
  return fallback ?? scan.workspacePath ?? undefined;
}

export interface KnowledgeCenterProps {
  project: Project;
  workspacePath: string | null;
  developmentScan: DevelopmentScan;
  available: boolean;
  revision?: number;
  onProposalCountChange?: (count: number) => void;
  onInitialize?: (workspacePath: string) => Promise<void>;
  onGenerateProposal?: (input: {
    workspacePath: string;
    sourceType: KnowledgeSourceType;
    sourceSnapshot: Record<string, unknown>;
    developmentContext: KnowledgeDevelopmentContext | null;
  }) => Promise<GeneratedKnowledgeProposal>;
}

export function KnowledgeCenter({
  project,
  workspacePath,
  developmentScan,
  available,
  revision = 0,
  onProposalCountChange,
  onInitialize,
  onGenerateProposal,
}: KnowledgeCenterProps) {
  const [section, setSection] = useState<KnowledgeSection>("published");
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [page, setPage] = useState<KnowledgePage | null>(null);
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [editedChanges, setEditedChanges] = useState<KnowledgeProposalChange[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspacePath ?? developmentScan.workspacePath ?? "");
  const [selectedContext, setSelectedContext] = useState<KnowledgeDevelopmentContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);

  const contextOptions = useMemo(() => {
    const rootBranch = developmentScan.contexts.find((context) => context.type === "branch");
    const rootPath = workspacePath ?? developmentScan.workspacePath;
    return [
      ...(rootPath ? [{
        key: "default",
        label: rootBranch?.type === "branch" ? `项目目录 · ${rootBranch.branch}` : "项目目录",
        path: rootPath,
        context: rootBranch?.type === "branch"
          ? { type: "branch" as const, branch: rootBranch.branch }
          : null,
      }] : []),
      ...developmentScan.contexts
        .filter((context) => context.type === "worktree")
        .map((context) => ({
          key: `worktree:${context.branch ?? context.path}`,
          label: `Worktree · ${context.branch ?? context.path.split(/[\\/]/).at(-1)}`,
          path: context.path,
          context: { type: "worktree" as const, branch: context.branch },
        })),
    ];
  }, [developmentScan, workspacePath]);

  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;
  const selectedChange = editedChanges.find((change) => change.id === selectedChangeId)
    ?? editedChanges[0]
    ?? null;
  const pendingCount = proposals.filter((proposal) => (
    proposal.status === "ready" || proposal.status === "generating" || proposal.status === "failed"
  )).length;
  const localReady = available && Boolean(selectedWorkspace);
  const selectedPageHealth = overview?.pages.find((candidate) => candidate.path === page?.path)?.health
    ?? page?.health;

  async function loadOverview(preferredPath?: string) {
    if (!localReady) {
      setLoading(false);
      return;
    }
    const versions = await getKnowledgeSourceVersions(project.id);
    const next = await checkKnowledge(project.id, selectedWorkspace, versions);
    setOverview(next);
    const nextPath = preferredPath
      ?? page?.path
      ?? next.indexPath
      ?? next.pages[0]?.path;
    if (nextPath && next.pages.some((candidate) => candidate.path === nextPath)) {
      setPage(await getKnowledgePage(project.id, nextPath, selectedWorkspace));
    } else {
      setPage(null);
    }
  }

  async function loadProposals() {
    const next = await listKnowledgeProposals(project.id);
    setProposals(next);
    const count = next.filter((proposal) => proposal.status === "ready").length;
    onProposalCountChange?.(count);
    setSelectedProposalId((current) => (
      current && next.some((proposal) => proposal.id === current)
        ? current
        : next[0]?.id ?? null
    ));
  }

  useEffect(() => {
    setSelectedWorkspace(workspacePath ?? developmentScan.workspacePath ?? "");
    setSelectedContext(null);
  }, [developmentScan.workspacePath, project.id, workspacePath]);

  useEffect(() => {
    if (!localReady) setSection("pending");
  }, [localReady, project.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      localReady
        ? getKnowledgeSourceVersions(project.id).then((versions) => (
          checkKnowledge(project.id, selectedWorkspace, versions)
        ))
        : null,
      listKnowledgeProposals(project.id),
    ]).then(async ([nextOverview, nextProposals]) => {
      if (cancelled) return;
      if (nextOverview) {
        setOverview(nextOverview);
        const firstPath = nextOverview.indexPath ?? nextOverview.pages[0]?.path;
        if (firstPath) {
          const firstPage = await getKnowledgePage(project.id, firstPath, selectedWorkspace);
          if (!cancelled) setPage(firstPage);
        } else {
          setPage(null);
        }
      }
      setProposals(nextProposals);
      setSelectedProposalId((current) => (
        current && nextProposals.some((proposal) => proposal.id === current)
          ? current
          : nextProposals[0]?.id ?? null
      ));
      onProposalCountChange?.(nextProposals.filter((proposal) => proposal.status === "ready").length);
    }).catch((nextError) => {
      if (!cancelled) setError(messageFor(nextError));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [localReady, onProposalCountChange, project.id, revision, selectedWorkspace]);

  useEffect(() => {
    if (!selectedProposal) {
      setEditedChanges([]);
      setSelectedChangeId(null);
      return;
    }
    setEditedChanges(selectedProposal.changes.map((change) => ({ ...change })));
    setSelectedChangeId(selectedProposal.changes[0]?.id ?? null);
  }, [selectedProposalId, selectedProposal?.version]);

  async function createGeneratedProposal(
    sourceType: KnowledgeSourceType,
    sourceSnapshot: Record<string, unknown>,
  ) {
    if (!selectedWorkspace || busy) return;
    setBusy(sourceType);
    setError(null);
    setNotice(null);
    try {
      const proposalInput = {
        workspacePath: selectedWorkspace,
        sourceType,
        sourceSnapshot,
        developmentContext: selectedContext,
      };
      const generated = onGenerateProposal
        ? await onGenerateProposal(proposalInput)
        : await generateKnowledgeProposal(project.id, proposalInput);
      if (generated.changes.length === 0) {
        setNotice(generated.summary || "本次没有发现需要长期沉淀的知识。 ");
        return;
      }
      const saved = await createKnowledgeProposal(project.id, generated);
      await loadProposals();
      setSelectedProposalId(saved.id);
      setSection("pending");
      setNotice("已生成待确认提案，正式知识尚未修改。");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function openPage(pagePath: string) {
    if (!selectedWorkspace) return;
    setBusy("page");
    setError(null);
    try {
      setPage(await getKnowledgePage(project.id, pagePath, selectedWorkspace));
      setSection("published");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function runSearch() {
    if (!searchValue.trim() || !selectedWorkspace) {
      setSearchResults([]);
      return;
    }
    setBusy("search");
    try {
      setSearchResults(await searchKnowledge(project.id, searchValue, selectedWorkspace));
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function runHealthCheck() {
    if (!selectedWorkspace) return;
    setBusy("check");
    setError(null);
    try {
      const versions = await getKnowledgeSourceVersions(project.id);
      const next = await checkKnowledge(project.id, selectedWorkspace, versions);
      setOverview(next);
      setSection("health");
      setNotice("知识来源检查已完成，未自动修改任何正文。");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function askQuestion() {
    if (!question.trim() || !selectedWorkspace) return;
    setBusy("ask");
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await askProjectKnowledge(project.id, question, selectedWorkspace));
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function persistEdits(proposal: KnowledgeProposal): Promise<KnowledgeProposal> {
    const saved = await updateKnowledgeProposal(proposal, { changes: editedChanges });
    setProposals((current) => current.map((candidate) => candidate.id === saved.id ? saved : candidate));
    return saved;
  }

  async function saveDraft() {
    if (!selectedProposal || busy) return;
    setBusy("save");
    setError(null);
    try {
      await persistEdits(selectedProposal);
      setNotice("提案草稿已保存，正式知识尚未修改。");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function publishProposal() {
    if (!selectedProposal || selectedProposal.status !== "ready" || busy) return;
    setBusy("publish");
    setError(null);
    try {
      const saved = await persistEdits(selectedProposal);
      const targetWorkspace = proposalWorkspace(saved, selectedWorkspace, developmentScan);
      await publishKnowledgeProposal(project.id, saved, targetWorkspace);
      const published = await updateKnowledgeProposal(saved, { status: "published" });
      setProposals((current) => current.map((candidate) => candidate.id === published.id ? published : candidate));
      setNotice("提案已发布，正式知识已更新。");
      setSection("published");
      try {
        await loadOverview();
      } catch (refreshError) {
        setError(`知识已成功发布，但页面刷新失败：${messageFor(refreshError)}`);
      }
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function rejectProposal() {
    if (!selectedProposal || selectedProposal.status !== "ready" || busy) return;
    setBusy("reject");
    try {
      const rejected = await updateKnowledgeProposal(selectedProposal, { status: "rejected" });
      setProposals((current) => current.map((candidate) => candidate.id === rejected.id ? rejected : candidate));
      setNotice("提案已驳回，项目文件没有变化。");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="knowledge-center">
      <header className="knowledge-header">
        <div>
          <h2>项目知识</h2>
          <p>{project.name} · 已发布知识与待确认提案</p>
        </div>
        <div className="knowledge-header-actions">
          {contextOptions.length > 1 && (
            <select
              aria-label="知识代码上下文"
              value={contextOptions.find((option) => option.path === selectedWorkspace)?.key ?? "default"}
              onChange={(event) => {
                const option = contextOptions.find((candidate) => candidate.key === event.target.value);
                if (!option) return;
                setSelectedWorkspace(option.path);
                setSelectedContext(option.context);
              }}
            >
              {contextOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          )}
          <button type="button" disabled={Boolean(busy) || !localReady} onClick={() => {
            if (!selectedWorkspace || busy) return;
            if (!onInitialize) {
              void createGeneratedProposal("project_scan", { requestedAt: new Date().toISOString() });
              return;
            }
            setBusy("project_scan");
            setError(null);
            void onInitialize(selectedWorkspace)
              .catch((nextError) => setError(messageFor(nextError)))
              .finally(() => setBusy(null));
          }}>{busy === "project_scan" ? "正在创建议题…" : overview?.initialized ? "重新分析" : "初始化知识库"}</button>
          <button type="button" disabled={Boolean(busy) || !localReady} onClick={() => void runHealthCheck()}>
            {busy === "check" ? "检查中…" : "检查更新"}
          </button>
          <button type="button" disabled={Boolean(busy) || !localReady} onClick={() => void createGeneratedProposal("project_review", {
            requestedAt: new Date().toISOString(),
          })}>阶段复盘</button>
        </div>
      </header>

      <nav className="knowledge-sections" aria-label="项目知识分类">
        <button type="button" className={section === "published" ? "active" : ""} onClick={() => setSection("published")}>已发布</button>
        <button type="button" className={section === "pending" ? "active" : ""} onClick={() => setSection("pending")}>待确认 {pendingCount || ""}</button>
        <button type="button" className={section === "health" ? "active" : ""} onClick={() => setSection("health")}>
          健康状态 {overview?.health.stale ? overview.health.stale : ""}
        </button>
      </nav>

      {error && <div className="knowledge-message error" role="alert">{error}</div>}
      {notice && <div className="knowledge-message" role="status">{notice}</div>}
      {loading ? <div className="knowledge-loading">正在读取项目知识…</div> : null}

      {!loading && section === "published" && !localReady && (
        <div className="knowledge-empty-state">
          <h2>{available ? "请先映射项目目录" : "已发布知识需要本地 Taskboard 服务"}</h2>
          <p>{available
            ? "项目知识只读取当前项目已映射的目录，不会尝试其他工作区。"
            : "读取和发布项目文件时，请通过本地 Taskboard 或 Codex 内嵌入口打开。"}</p>
        </div>
      )}

      {!loading && section === "published" && localReady && (
        <div className="knowledge-published-layout">
          <aside className="knowledge-sidebar">
            <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <input value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="搜索知识…" />
            </form>
            {searchValue && searchResults.length > 0 ? (
              <div className="knowledge-search-results">
                {searchResults.map((result) => (
                  <button type="button" key={result.path} onClick={() => void openPage(result.path)}>
                    <strong>{result.title}</strong><span>{result.excerpt}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="knowledge-page-list">
                {(overview?.pages ?? []).map((candidate) => (
                  <button
                    type="button"
                    className={page?.path === candidate.path ? "active" : ""}
                    key={candidate.path}
                    onClick={() => void openPage(candidate.path)}
                  >
                    <span>{candidate.title}</span>
                    <small className={`is-${candidate.health}`}>{HEALTH_LABELS[candidate.health]}</small>
                  </button>
                ))}
              </div>
            )}
          </aside>
          <main className="knowledge-document">
            {!overview?.initialized ? (
              <div className="knowledge-empty-document">
                <h3>项目知识尚未初始化</h3>
                <p>点击“初始化知识库”会先生成待确认提案，确认发布前不会创建知识文件。</p>
              </div>
            ) : page ? (
              <>
                <div className="knowledge-document-meta">
                  <span>{page.kind}</span><span>{HEALTH_LABELS[selectedPageHealth ?? page.health]}</span>
                  {page.updatedAt && <span>{page.updatedAt}</span>}
                </div>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.content}</ReactMarkdown>
              </>
            ) : null}
          </main>
          <aside className="knowledge-question-panel">
            <h3>询问项目</h3>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：评论是如何写入并关联会话的？" />
            <button type="button" disabled={Boolean(busy) || !question.trim()} onClick={() => void askQuestion()}>
              {busy === "ask" ? "回答中…" : "提问"}
            </button>
            {answer && (
              <div className="knowledge-answer">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.answer}</ReactMarkdown>
                <ul>{answer.citations.map((citation) => <li key={`${citation.type}:${citation.ref}`}>{citation.label} · {citation.ref}</li>)}</ul>
                <button type="button" disabled={Boolean(busy)} onClick={() => void createGeneratedProposal("question", {
                  question,
                  answer: answer.answer,
                  citations: answer.citations,
                })}>保存为知识提案</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {!loading && section === "pending" && (
        <div className="knowledge-review-layout">
          <aside className="knowledge-proposal-list">
            {proposals.map((proposal) => (
              <button
                type="button"
                className={proposal.id === selectedProposalId ? "active" : ""}
                key={proposal.id}
                onClick={() => setSelectedProposalId(proposal.id)}
              >
                <strong>{proposal.title}</strong>
                <span>{SOURCE_LABELS[proposal.sourceType]} · {proposal.changes.length} 个文件</span>
                <small className={`is-${proposal.status}`}>{proposal.status}</small>
              </button>
            ))}
            {proposals.length === 0 && <p>暂无知识提案。</p>}
          </aside>
          <main className="knowledge-proposal-detail">
            {selectedProposal ? (
              <>
                <header>
                  <div><h3>{selectedProposal.title}</h3><p>{selectedProposal.summary}</p></div>
                  {selectedProposal.status === "ready" && (
                    <div>
                      <button type="button" disabled={Boolean(busy)} onClick={() => void saveDraft()}>
                        {busy === "save" ? "保存中…" : "保存草稿"}
                      </button>
                      <button type="button" disabled={Boolean(busy)} onClick={() => void rejectProposal()}>驳回</button>
                      <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void publishProposal()}>
                        {busy === "publish" ? "发布中…" : "确认发布"}
                      </button>
                    </div>
                  )}
                </header>
                <details className="knowledge-proposal-source">
                  <summary>来源快照 · {SOURCE_LABELS[selectedProposal.sourceType]}</summary>
                  <pre>{JSON.stringify(selectedProposal.sourceSnapshot, null, 2)}</pre>
                </details>
                <div className="knowledge-change-tabs">
                  {editedChanges.map((change) => (
                    <button
                      type="button"
                      className={change.id === selectedChange?.id ? "active" : ""}
                      key={change.id}
                      onClick={() => setSelectedChangeId(change.id)}
                    >{change.operation} · {change.targetPath}</button>
                  ))}
                </div>
                {selectedChange && (
                  <div className="knowledge-change-editor">
                    <div className="knowledge-line-diff" aria-label="知识文件行级差异">
                      {lineDiff(selectedChange.beforeContent, selectedChange.afterContent).map((row, index) => (
                        <div className={`diff-${row.type}`} key={`${index}:${row.text}`}>
                          <span>{row.type === "add" ? "+" : row.type === "remove" ? "−" : " "}</span>
                          <code>{row.text || " "}</code>
                        </div>
                      ))}
                    </div>
                    {selectedProposal.status === "ready" && selectedChange.operation !== "delete" && (
                      <label>发布内容
                        <textarea
                          value={selectedChange.afterContent ?? ""}
                          onChange={(event) => setEditedChanges((current) => current.map((change) => (
                            change.id === selectedChange.id ? { ...change, afterContent: event.target.value } : change
                          )))}
                        />
                      </label>
                    )}
                  </div>
                )}
              </>
            ) : <p className="knowledge-detail-placeholder">选择一份提案查看来源和文件差异。</p>}
          </main>
        </div>
      )}

      {!loading && section === "health" && !localReady && (
        <div className="knowledge-empty-state">
          <h2>健康检查需要本地项目目录</h2>
          <p>待确认提案仍可审核；来源与代码新鲜度检查会在本地 Taskboard 服务中执行。</p>
        </div>
      )}

      {!loading && section === "health" && localReady && (
        <div className="knowledge-health-view">
          <div className="knowledge-health-summary">
            <span><strong>{overview?.health.fresh ?? 0}</strong>最新</span>
            <span><strong>{overview?.health.stale ?? 0}</strong>可能过期</span>
            <span><strong>{overview?.health.unverified ?? 0}</strong>待验证</span>
            <span><strong>{overview?.health.missingSources ?? 0}</strong>缺少来源</span>
          </div>
          {(overview?.pages ?? []).filter((candidate) => candidate.health !== "fresh").map((candidate) => (
            <article key={candidate.path}>
              <div><h3>{candidate.title}</h3><p>{candidate.path}</p></div>
              <span className={`is-${candidate.health}`}>{HEALTH_LABELS[candidate.health]}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void createGeneratedProposal("stale_refresh", {
                pages: [candidate.path],
                sources: candidate.sources,
              })}>生成修订提案</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
