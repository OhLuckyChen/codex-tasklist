import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";
import {
  normalizeCodexEvent,
  spawnCodexTurn,
} from "./codex-process.mjs";

const execFileAsync = promisify(execFile);
const KNOWLEDGE_DIRECTORY = path.join("docs", "knowledge");
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PROPOSAL_CHANGES = 50;
const MAX_PROPOSAL_BYTES = 5 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_SOURCE_TYPES = new Set([
  "project_scan",
  "issue",
  "comments",
  "question",
  "stale_refresh",
  "project_review",
]);
const ALLOWED_OPERATIONS = new Set(["create", "update", "delete"]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stringValue(value) {
  const normalized = String(value ?? "").trim();
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return { attributes: {}, sources: [], body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { attributes: {}, sources: [], body: content };
  const header = content.slice(4, end).split("\n");
  const attributes = {};
  const sources = [];
  let currentSource = null;
  let inSources = false;
  for (const line of header) {
    if (line.trim() === "sources:") {
      inSources = true;
      continue;
    }
    if (inSources && /^\s*-\s+/.test(line)) {
      currentSource = {};
      sources.push(currentSource);
      const match = line.match(/^\s*-\s+([^:]+):\s*(.*)$/);
      if (match) currentSource[match[1].trim()] = stringValue(match[2]);
      continue;
    }
    if (inSources && currentSource && /^\s{4,}[^:]+:/.test(line)) {
      const match = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (match) currentSource[match[1].trim()] = stringValue(match[2]);
      continue;
    }
    if (/^\S/.test(line)) inSources = false;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match && !inSources) attributes[match[1].trim()] = stringValue(match[2]);
  }
  return {
    attributes,
    sources,
    body: content.slice(end + 5),
  };
}

function markdownTitle(content, fallback) {
  const parsed = parseFrontmatter(content);
  if (parsed.attributes.title) return parsed.attributes.title;
  const heading = parsed.body.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path must be a non-empty relative path");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path must stay inside the project");
  }
  return normalized;
}

function isAllowedTarget(relativePath) {
  return relativePath === "changelog.md"
    || (relativePath.startsWith("docs/knowledge/") && relativePath.endsWith(".md"));
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function existingRealRoot(workspacePath) {
  const resolved = path.resolve(workspacePath);
  const stats = await lstat(resolved).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new ApiError(400, "WORKSPACE_UNAVAILABLE", "The selected project workspace is unavailable");
  }
  return realpath(resolved);
}

async function safeTarget(workspaceRoot, relativePath, { allowMissing = true } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const candidate = path.resolve(workspaceRoot, normalized);
  if (!isInside(workspaceRoot, candidate)) {
    throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path escapes the project workspace");
  }
  const parent = path.dirname(candidate);
  let existingParent = parent;
  while (existingParent !== workspaceRoot) {
    const stats = await lstat(existingParent).catch(() => null);
    if (stats) break;
    existingParent = path.dirname(existingParent);
  }
  const parentReal = await realpath(existingParent).catch(() => workspaceRoot);
  if (!isInside(workspaceRoot, parentReal)) {
    throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path follows a symlink outside the project");
  }
  const stats = await lstat(candidate).catch(() => null);
  if (!stats) {
    if (!allowMissing) throw new ApiError(404, "KNOWLEDGE_PAGE_NOT_FOUND", `Knowledge page '${normalized}' does not exist`);
    return { normalized, candidate, stats: null };
  }
  if (stats.isSymbolicLink()) {
    const targetReal = await realpath(candidate);
    if (!isInside(workspaceRoot, targetReal)) {
      throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path follows a symlink outside the project");
    }
  }
  if (!stats.isFile()) {
    throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Knowledge path must refer to a file");
  }
  return { normalized, candidate, stats };
}

async function readCapped(filePath) {
  const stats = await lstat(filePath);
  if (stats.size > MAX_PAGE_BYTES) {
    throw new ApiError(413, "KNOWLEDGE_PAGE_TOO_LARGE", "Knowledge pages cannot exceed 1 MiB");
  }
  return readFile(filePath, "utf8");
}

async function listMarkdownFiles(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute, root));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return files;
}

function inaccessibleSource(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}

async function sourceRevision(workspaceRoot, relativePath, expectedRevision = "") {
  let target;
  try {
    target = await safeTarget(workspaceRoot, relativePath, { allowMissing: false });
  } catch (error) {
    if (inaccessibleSource(error)) return undefined;
    if (error?.code === "KNOWLEDGE_PAGE_NOT_FOUND" || error?.code === "ENOENT") return null;
    throw error;
  }
  if (String(expectedRevision).startsWith("sha256:")) {
    try {
      return sha256(await readFile(target.candidate));
    } catch (error) {
      if (inaccessibleSource(error)) return undefined;
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "hash-object", "--", target.normalized],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const hash = stdout.trim();
    if (hash) return `git-blob:${hash}`;
  } catch {}
  try {
    return sha256(await readFile(target.candidate));
  } catch (error) {
    if (inaccessibleSource(error)) return undefined;
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function pageKind(relativePath, attributes) {
  if (attributes.kind) return attributes.kind;
  const parts = relativePath.split("/");
  if (parts.length > 3) return parts[2];
  return path.posix.basename(relativePath, ".md");
}

async function inspectPage(workspaceRoot, relativePath, sourceVersions = {}) {
  const target = await safeTarget(workspaceRoot, relativePath, { allowMissing: false });
  const content = await readCapped(target.candidate);
  const parsed = parseFrontmatter(content);
  const sourceStates = [];
  for (const source of parsed.sources) {
    if (source.type === "file" && source.ref) {
      const resolvedRevision = await sourceRevision(workspaceRoot, source.ref, source.revision);
      const actualRevision = resolvedRevision ?? null;
      const status = resolvedRevision === undefined
        ? "unverified"
        : resolvedRevision === null
          ? "missing"
          : !source.revision
          ? "unverified"
          : resolvedRevision === source.revision
            ? "fresh"
            : "stale";
      sourceStates.push({ ...source, actualRevision, status });
      continue;
    }
    if ((source.type === "issue" || source.type === "comment") && source.ref) {
      const actualRevision = sourceVersions[`${source.type}:${source.ref}`] ?? null;
      const status = actualRevision === null
        ? "unverified"
        : String(actualRevision) === String(source.revision)
          ? "fresh"
          : "stale";
      sourceStates.push({ ...source, actualRevision, status });
      continue;
    }
    sourceStates.push({ ...source, actualRevision: null, status: "unverified" });
  }
  const health = sourceStates.length === 0
    ? "missing_sources"
    : sourceStates.some((source) => source.status === "missing" || source.status === "stale")
      ? "stale"
      : sourceStates.some((source) => source.status === "unverified")
        ? "unverified"
        : "fresh";
  return {
    path: relativePath,
    id: parsed.attributes.id || relativePath,
    title: markdownTitle(content, path.posix.basename(relativePath, ".md")),
    kind: pageKind(relativePath, parsed.attributes),
    updatedAt: parsed.attributes.updated_at || null,
    health,
    sources: sourceStates,
    content: parsed.body,
  };
}

function proposalInputBytes(changes) {
  return changes.reduce(
    (total, change) => total + Buffer.byteLength(change.afterContent ?? "") + Buffer.byteLength(change.beforeContent ?? ""),
    0,
  );
}

function parseStructuredMessage(message) {
  const trimmed = String(message ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [fenced, trimmed].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  throw new ApiError(502, "KNOWLEDGE_ANALYSIS_INVALID", "Project analysis did not return valid structured data");
}

async function runCodexJson({ executable, workspacePath, prompt, processEnv }) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--color",
    "never",
    "-C",
    workspacePath,
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-",
  ];
  let message = "";
  let terminal = null;
  let terminalError = "";
  const { child, completion } = spawnCodexTurn({
    executable,
    args,
    prompt,
    env: processEnv,
    onRawEvent(raw) {
      const normalized = normalizeCodexEvent(raw);
      if (normalized?.kind === "event" && normalized.role === "assistant" && normalized.content) {
        message = normalized.content;
      }
      if (raw.type === "turn.completed") terminal = "completed";
      if (raw.type === "turn.failed" || raw.type === "error") {
        terminal = "failed";
        terminalError ||= normalized?.content || "Project analysis failed";
      }
    },
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        if (Number.isInteger(child.pid)) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
      reject(new ApiError(504, "KNOWLEDGE_ANALYSIS_TIMEOUT", "Project analysis timed out"));
    }, ANALYSIS_TIMEOUT_MS);
    timeoutId.unref();
  });
  let result;
  try {
    result = await Promise.race([completion, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  if (result.exitCode !== 0 || terminal !== "completed") {
    throw new ApiError(502, "KNOWLEDGE_ANALYSIS_FAILED", terminalError || "Project analysis failed");
  }
  return parseStructuredMessage(message);
}

function analysisPrompt(sourceType, sourceSnapshot) {
  return [
    "You are preparing a project-knowledge change proposal. Work read-only. Do not edit files.",
    `Source type: ${sourceType}`,
    "Read the current docs/knowledge content first when it exists, then inspect only relevant code, configuration, tests and project documents.",
    "Formal knowledge is current project truth. Pending or unverified ideas must not be written as facts.",
    "Prefer updating an existing topic page. Create a new page only when no existing page can hold the topic.",
    "Technical designs belong under docs/knowledge/designs/. Decisions, detailed flows and guides use their matching directories.",
    "Allowed targets are docs/knowledge/**/*.md and changelog.md. Include changelog.md only for an actual project behavior change.",
    "Every knowledge page must have YAML frontmatter with id, title, kind, updated_at and sources. Source refs are project-relative paths or issue/comment identifiers. For file sources, record the current revision as git-blob:<git hash-object value>; for issue/comment sources, use the supplied version. These revisions are the deterministic baseline for later incremental checks.",
    "Return JSON only with this shape:",
    '{"title":"...","summary":"...","changes":[{"targetPath":"docs/knowledge/...md","operation":"create|update|delete","afterContent":"full file content"}]}',
    "For delete operations omit afterContent. Never include unchanged files.",
    sourceSnapshot === undefined ? "" : `Source snapshot:\n${JSON.stringify(sourceSnapshot, null, 2)}`,
  ].filter(Boolean).join("\n\n");
}

function knowledgeRunInstruction({ sourceType, sourceSnapshot, workspacePath, callbackUrl, callbackToken }) {
  const scanMode = sourceType === "project_scan"
    ? "This is the initial analysis. Build a complete project understanding before proposing the initial knowledge structure; cover architecture, code map, core flows, engineering notes, durable designs and confirmed decisions."
    : sourceType === "project_review"
      ? "This is a full project review. Compare the complete current project with published knowledge and propose only missing, stale or contradicted durable knowledge."
      : sourceType === "stale_refresh"
        ? "This is an incremental analysis. Start from the changed or stale sources and affected knowledge pages listed in the source snapshot, trace their impact through the current project, and leave unrelated knowledge unchanged."
        : "Use the source snapshot as the trigger, verify it against the current project, and propose only durable knowledge supported by evidence.";
  return [
    analysisPrompt(sourceType, sourceSnapshot),
    `Expected project root: ${workspacePath}`,
    "Before analyzing, run pwd and verify that its real path is exactly the expected project root. If it is not, stop and submit {\"error\":\"expected project root ... but got ...\"} to the callback instead of inventing a proposal.",
    "Analyze the complete current project directly. You may inspect any project file needed, but do not edit, create, delete or format project files.",
    scanMode,
    "When the JSON proposal is ready, submit it to Taskboard with one local HTTP POST. The success request body is {\"analysis\": <the proposal JSON>}; if analysis cannot run, submit {\"error\":\"specific failure reason\"}.",
    `Callback URL: ${callbackUrl}`,
    `Header: X-Taskboard-Knowledge-Run-Token: ${callbackToken}`,
    "Use curl with --data-binary @- so large JSON is sent through stdin rather than a command-line argument.",
    "A successful callback returns {\"ok\":true}. Do not publish or write knowledge files yourself. After the callback succeeds, briefly tell the user that a pending proposal is available in Taskboard.",
  ].join("\n\n");
}

function questionPrompt(question) {
  return [
    "Answer the project question using the current docs/knowledge and current code/configuration/tests.",
    "For current behavior, verify against code rather than trusting a possibly stale page.",
    "Return JSON only with this shape:",
    '{"answer":"Markdown answer","citations":[{"type":"knowledge|file|issue","ref":"project-relative path or issue identifier","label":"short label"}]}',
    `Question: ${question}`,
  ].join("\n\n");
}

export class KnowledgeService {
  constructor(options = {}) {
    this.codexExecutable = options.codexExecutable ?? "codex";
    this.processEnv = options.processEnv ?? process.env;
    this.analyze = options.analyze ?? ((input) => runCodexJson({
      executable: this.codexExecutable,
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      processEnv: this.processEnv,
    }));
  }

  async overview(workspacePath, sourceVersions = {}) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    const knowledgeRoot = path.join(workspaceRoot, KNOWLEDGE_DIRECTORY);
    const relativePaths = await listMarkdownFiles(knowledgeRoot, workspaceRoot);
    const pages = [];
    for (const relativePath of relativePaths) {
      pages.push(await inspectPage(workspaceRoot, relativePath, sourceVersions));
    }
    const summaries = pages.map(({ content: _content, ...page }) => page);
    const health = {
      fresh: summaries.filter((page) => page.health === "fresh").length,
      stale: summaries.filter((page) => page.health === "stale").length,
      unverified: summaries.filter((page) => page.health === "unverified").length,
      missingSources: summaries.filter((page) => page.health === "missing_sources").length,
    };
    return {
      initialized: summaries.length > 0,
      pages: summaries,
      health,
      indexPath: summaries.some((page) => page.path === "docs/knowledge/index.md")
        ? "docs/knowledge/index.md"
        : null,
    };
  }

  async readPage(workspacePath, relativePath, sourceVersions = {}) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized.startsWith("docs/knowledge/") || !normalized.endsWith(".md")) {
      throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", "Only Markdown knowledge pages can be read");
    }
    return inspectPage(workspaceRoot, normalized, sourceVersions);
  }

  async search(workspacePath, query) {
    const normalizedQuery = String(query ?? "").trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];
    if (normalizedQuery.length > 200) {
      throw new ApiError(400, "INVALID_QUERY", "Knowledge search cannot exceed 200 characters");
    }
    const overview = await this.overview(workspacePath);
    const results = [];
    for (const page of overview.pages) {
      const full = await this.readPage(workspacePath, page.path);
      const haystack = `${page.title}\n${full.content}`.toLocaleLowerCase();
      const index = haystack.indexOf(normalizedQuery);
      if (index === -1) continue;
      const plain = full.content.replace(/[`#>*_\[\]]/g, " ").replace(/\s+/g, " ").trim();
      const plainIndex = plain.toLocaleLowerCase().indexOf(normalizedQuery);
      results.push({
        path: page.path,
        title: page.title,
        kind: page.kind,
        excerpt: plainIndex === -1
          ? plain.slice(0, 180)
          : plain.slice(Math.max(0, plainIndex - 60), plainIndex + normalizedQuery.length + 120),
      });
    }
    return results.slice(0, 50);
  }

  async generateProposal(workspacePath, input) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    if (!ALLOWED_SOURCE_TYPES.has(input?.sourceType)) {
      throw new ApiError(400, "INVALID_SOURCE_TYPE", "Unknown knowledge proposal source type");
    }
    const analyzed = await this.analyze({
      workspacePath: workspaceRoot,
      prompt: analysisPrompt(input.sourceType, input.sourceSnapshot),
      sourceType: input.sourceType,
      sourceSnapshot: input.sourceSnapshot,
    });
    return this.prepareProposal(workspaceRoot, input, analyzed);
  }

  async prepareProposal(workspacePath, input, analyzed) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    if (!ALLOWED_SOURCE_TYPES.has(input?.sourceType)) {
      throw new ApiError(400, "INVALID_SOURCE_TYPE", "Unknown knowledge proposal source type");
    }
    if (!analyzed || typeof analyzed !== "object" || !Array.isArray(analyzed.changes)) {
      throw new ApiError(502, "KNOWLEDGE_ANALYSIS_INVALID", "Project analysis returned an invalid proposal");
    }
    const analysisSummary = String(analyzed.summary ?? "");
    if (
      /operation not permitted|permission denied/i.test(analysisSummary)
      || /无法读取(?:指定)?工作空间|无权访问工作空间/.test(analysisSummary)
    ) {
      throw new ApiError(
        403,
        "KNOWLEDGE_WORKSPACE_PERMISSION_DENIED",
        "The Taskboard background service cannot read the selected project directory",
      );
    }
    if (analyzed.changes.length === 0) {
      return {
        title: String(analyzed.title || "No knowledge changes"),
        summary: analysisSummary || "No durable project knowledge was found.",
        sourceType: input.sourceType,
        sourceSnapshot: input.sourceSnapshot ?? {},
        developmentContext: input.developmentContext ?? null,
        changes: [],
      };
    }
    if (analyzed.changes.length > MAX_PROPOSAL_CHANGES) {
      throw new ApiError(413, "KNOWLEDGE_PROPOSAL_TOO_LARGE", "A proposal cannot change more than 50 files");
    }
    const changes = [];
    for (const [index, raw] of analyzed.changes.entries()) {
      const targetPath = normalizeRelativePath(raw?.targetPath);
      if (!isAllowedTarget(targetPath)) {
        throw new ApiError(400, "INVALID_KNOWLEDGE_PATH", `Proposal target '${targetPath}' is not allowed`);
      }
      const operation = raw?.operation;
      if (!ALLOWED_OPERATIONS.has(operation)) {
        throw new ApiError(400, "INVALID_KNOWLEDGE_OPERATION", "Proposal operation must be create, update or delete");
      }
      const target = await safeTarget(workspaceRoot, targetPath);
      const beforeContent = target.stats ? await readCapped(target.candidate) : null;
      if (operation === "create" && beforeContent !== null) {
        throw new ApiError(409, "KNOWLEDGE_TARGET_EXISTS", `Proposal cannot create existing file '${targetPath}'`);
      }
      if ((operation === "update" || operation === "delete") && beforeContent === null) {
        throw new ApiError(409, "KNOWLEDGE_TARGET_MISSING", `Proposal cannot ${operation} missing file '${targetPath}'`);
      }
      const afterContent = operation === "delete" ? null : String(raw?.afterContent ?? "");
      if (operation !== "delete" && (!afterContent.trim() || Buffer.byteLength(afterContent) > MAX_PAGE_BYTES)) {
        throw new ApiError(413, "KNOWLEDGE_PAGE_TOO_LARGE", "Proposed knowledge pages must contain at most 1 MiB");
      }
      changes.push({
        id: randomUUID(),
        targetPath,
        operation,
        baseDigest: beforeContent === null ? null : sha256(beforeContent),
        beforeContent,
        afterContent,
        sortOrder: index,
      });
    }
    if (proposalInputBytes(changes) > MAX_PROPOSAL_BYTES) {
      throw new ApiError(413, "KNOWLEDGE_PROPOSAL_TOO_LARGE", "A proposal cannot exceed 5 MiB");
    }
    return {
      title: String(analyzed.title || "Project knowledge update").slice(0, 240),
      summary: String(analyzed.summary || "").slice(0, 20_000),
      sourceType: input.sourceType,
      sourceSnapshot: input.sourceSnapshot ?? {},
      developmentContext: input.developmentContext ?? null,
      changes,
    };
  }

  knowledgeRunInstruction(input) {
    if (!ALLOWED_SOURCE_TYPES.has(input?.sourceType)) {
      throw new ApiError(400, "INVALID_SOURCE_TYPE", "Unknown knowledge proposal source type");
    }
    return knowledgeRunInstruction(input);
  }

  async ask(workspacePath, question) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    const normalized = String(question ?? "").trim();
    if (!normalized || normalized.length > 20_000) {
      throw new ApiError(400, "INVALID_QUESTION", "A project question is required and cannot exceed 20,000 characters");
    }
    const answer = await this.analyze({
      workspacePath: workspaceRoot,
      prompt: questionPrompt(normalized),
      sourceType: "question",
      question: normalized,
    });
    if (!answer || typeof answer.answer !== "string" || !Array.isArray(answer.citations)) {
      throw new ApiError(502, "KNOWLEDGE_ANSWER_INVALID", "Project question did not return a sourced answer");
    }
    return {
      answer: answer.answer,
      citations: answer.citations
        .filter((citation) => citation && typeof citation.ref === "string")
        .slice(0, 50)
        .map((citation) => ({
          type: ["knowledge", "file", "issue"].includes(citation.type) ? citation.type : "file",
          ref: citation.ref,
          label: String(citation.label || citation.ref).slice(0, 240),
        })),
    };
  }

  async publish(workspacePath, proposal) {
    const workspaceRoot = await existingRealRoot(workspacePath);
    if (!proposal || !Array.isArray(proposal.changes) || proposal.changes.length === 0) {
      throw new ApiError(400, "EMPTY_KNOWLEDGE_PROPOSAL", "A proposal must contain at least one file change");
    }
    if (proposal.changes.length > MAX_PROPOSAL_CHANGES || proposalInputBytes(proposal.changes) > MAX_PROPOSAL_BYTES) {
      throw new ApiError(413, "KNOWLEDGE_PROPOSAL_TOO_LARGE", "Knowledge proposal exceeds the publish limit");
    }
    const prepared = [];
    for (const raw of proposal.changes) {
      const targetPath = normalizeRelativePath(raw.targetPath);
      if (!isAllowedTarget(targetPath) || !ALLOWED_OPERATIONS.has(raw.operation)) {
        throw new ApiError(400, "INVALID_KNOWLEDGE_CHANGE", "Knowledge proposal contains an invalid file change");
      }
      const target = await safeTarget(workspaceRoot, targetPath);
      const beforeContent = target.stats ? await readCapped(target.candidate) : null;
      const actualDigest = beforeContent === null ? null : sha256(beforeContent);
      const afterContent = raw.operation === "delete" ? null : String(raw.afterContent ?? "");
      const alreadyApplied = raw.operation === "delete"
        ? beforeContent === null
        : beforeContent === afterContent;
      if (!alreadyApplied && actualDigest !== (raw.baseDigest ?? null)) {
        throw new ApiError(409, "KNOWLEDGE_PUBLISH_CONFLICT", `File '${targetPath}' changed after the proposal was generated`, {
          targetPath,
          expectedDigest: raw.baseDigest ?? null,
          actualDigest,
        });
      }
      if (raw.operation !== "delete" && (!afterContent.trim() || Buffer.byteLength(afterContent) > MAX_PAGE_BYTES)) {
        throw new ApiError(413, "KNOWLEDGE_PAGE_TOO_LARGE", "Proposed knowledge pages must contain at most 1 MiB");
      }
      prepared.push({ targetPath, target, operation: raw.operation, beforeContent, afterContent, alreadyApplied });
    }

    const completed = [];
    try {
      for (const change of prepared) {
        if (change.alreadyApplied) continue;
        if (change.operation === "delete") {
          await unlink(change.target.candidate);
        } else {
          await mkdir(path.dirname(change.target.candidate), { recursive: true });
          const temporary = path.join(
            path.dirname(change.target.candidate),
            `.${path.basename(change.target.candidate)}.${randomUUID()}.tmp`,
          );
          await writeFile(temporary, change.afterContent, { flag: "wx", mode: 0o644 });
          await rename(temporary, change.target.candidate);
        }
        completed.push(change);
      }
    } catch (error) {
      for (const change of [...completed].reverse()) {
        try {
          if (change.beforeContent === null) {
            await rm(change.target.candidate, { force: true });
          } else {
            await mkdir(path.dirname(change.target.candidate), { recursive: true });
            await writeFile(change.target.candidate, change.beforeContent, { mode: 0o644 });
          }
        } catch {}
      }
      throw new ApiError(500, "KNOWLEDGE_PUBLISH_FAILED", error instanceof Error ? error.message : "Knowledge publish failed");
    }
    return {
      publishedAt: new Date().toISOString(),
      changes: prepared.map((change) => ({
        targetPath: change.targetPath,
        operation: change.operation,
        digest: change.afterContent === null ? null : sha256(change.afterContent),
      })),
    };
  }
}

export const knowledgeInternals = {
  parseFrontmatter,
  sha256,
  normalizeRelativePath,
  isAllowedTarget,
};
