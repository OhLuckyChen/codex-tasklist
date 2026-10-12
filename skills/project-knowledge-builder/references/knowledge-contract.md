# Project knowledge contract

## Contents

1. Published and pending boundary
2. Page taxonomy
3. Pre-index taxonomy
4. Page format
5. Pre-index format
6. Proposal format
7. Initial coverage
8. Incremental maintenance

## 1. Published and pending boundary

Published knowledge lives only in the analyzed project's `docs/knowledge/`, `.taskboard/knowledge-index/`, and its existing `changelog.md`. Markdown knowledge contains confirmed current facts and completed decisions. Pre-index JSON contains machine-readable routing metadata derived from current evidence.

Pending knowledge lives only in Taskboard's proposal queue until a user reviews and publishes it. A proposal may contain a well-supported fact that has not yet been reviewed, an unresolved option explicitly labeled as pending, or a correction to stale published knowledge. Do not create `pending.md` in the project.

Promotion requires all of the following:

- The statement is supported by current project evidence or an explicitly confirmed decision.
- Any related implementation is complete and verified when the statement claims implemented behavior.
- Conflicts and open questions are resolved or remain clearly excluded from the published text.
- A user accepts the proposal in Taskboard.

## 2. Page taxonomy

- `docs/knowledge/index.md`: one-sentence project summary, category navigation, latest confirmed update time. Health is computed by Taskboard and must not be hard-coded.
- `docs/knowledge/project-overview.md`: goals, users, core capabilities, technology stack, and how to run or verify the project.
- `docs/knowledge/architecture.md`: components, ownership boundaries, data/control flow, and local or external relationships.
- `docs/knowledge/code-map.md`: main entry points, module responsibilities, and where to start common changes.
- `docs/knowledge/key-flows.md`: the small number of end-to-end flows that are central to the product.
- `docs/knowledge/engineering-notes.md`: build, operation, constraints, recurring failure modes, and verified lessons.
- `docs/knowledge/data-boundaries.md`: state authority, object ownership, persistence boundaries, projections, caches, and external data contracts.
- `docs/knowledge/interfaces-and-entrypoints.md`: critical user, API, CLI, script, job, event, configuration, and public function entry points with purpose and success semantics.
- `docs/knowledge/designs/<topic>.md`: a technical design that is implemented or explicitly accepted and still useful.
- `docs/knowledge/decisions/<topic>.md`: a durable decision, alternatives considered, status, and consequences.
- `docs/knowledge/flows/<topic>.md`: a detailed specialist flow that would overload `key-flows.md`.
- `docs/knowledge/guides/<topic>.md`: reusable development, troubleshooting, or operational procedure.
- `changelog.md`: chronological record of actual completed project changes. It is not a knowledge index, proposal log, or work journal.

Do not create a page when its useful content fits an existing owner page. Do not create empty category directories.

## 3. Pre-index taxonomy

Pre-index files live under `.taskboard/knowledge-index/`. They are compact JSON files for routing questions to candidate files, symbols, documents, and recent changes before reading source. They are not human-facing narrative pages.

- `.taskboard/knowledge-index/manifest.json`: schema version, project summary, generated time, scan scope, excluded paths, and source revisions when available.
- `.taskboard/knowledge-index/files.json`: file records with path, type, language, size, mtime when available, keywords, owning component, and freshness or revision when available.
- `.taskboard/knowledge-index/symbols.json`: functions, classes, API routes, CLI commands, scripts, config keys, and public request/response shapes with path, line, signature or route, method, request fields, response fields, importance, evidence status, linked knowledge, and keywords.
- `.taskboard/knowledge-index/entrypoints.json`: user, API, CLI, script, job, event, configuration, and public function entry points with business/runtime purpose, full callable route including deployment prefix or compatibility aliases, method, required request fields, success semantics, importance, evidence status, and linked knowledge.
- `.taskboard/knowledge-index/objects.json`: core objects with stable ID, authority, creators/updaters, state source, states, invariants, evidence, and confidence.
- `.taskboard/knowledge-index/flows.json`: central flows with trigger, entry point, components, state changes, success semantics, failure semantics, evidence, and confidence.
- `.taskboard/knowledge-index/docs.json`: README, docs, published knowledge pages, and high-value Taskboard proposal summaries with title, source, keywords, summary, and health or proposal status.
- `.taskboard/knowledge-index/recent.json`: recent git or mtime-based changes with path, changed_at, source, status, and reason.

Do not include secrets, absolute local paths, raw conversation logs, temporary run directories, build outputs, vendored dependencies, or generated caches. Use project-relative paths only.

## 4. Page format

Every proposed knowledge page is a complete Markdown file with YAML frontmatter:

```yaml
---
id: stable-kebab-case-id
title: Human-readable title
kind: overview|architecture|code-map|flow|engineering|design|decision|guide
updated_at: 2026-08-10T00:00:00.000Z
sources:
  - type: file
    ref: project/relative/path
    revision: git-blob:<git-hash-object>
    symbol: optional precise symbol or section
  - type: issue
    ref: PROJECT-123
    revision: "4"
  - type: comment
    ref: comment-uuid
    revision: "2"
---
```

Use project-relative paths only. Never store a machine-specific absolute path. For a non-Git project, use the `sha256:` revision returned or accepted by Taskboard rather than inventing a Git revision.

The body should lead with the fact or model, then give boundaries, relationships, and operational consequences. Use a compact table or Mermaid diagram only when it materially improves a multi-component mapping or flow.

Write user-facing knowledge pages in Chinese unless the project already has a stronger local documentation convention.

## 5. Pre-index format

Pre-index files must be valid JSON, not Markdown. Use an object for `manifest.json`; use arrays for `files.json`, `symbols.json`, `entrypoints.json`, `objects.json`, `flows.json`, `docs.json`, and `recent.json`. Keep entries concise and project-relative.

Example `symbols.json` entry:

```json
{
  "path": "app/api/repowiki_download.py",
  "name": "download_repowiki_files",
  "kind": "api_route",
  "contractType": "api_route",
  "importance": "critical",
  "evidenceStatus": "confirmed",
  "language": "python",
  "line": 42,
  "method": ["GET", "POST"],
  "route": "/aicodingkbmgr/engineering-doc/download/files",
  "aliases": ["/engineering-doc/download/files"],
  "requestFields": ["mode", "domain_id", "smileId", "workspace"],
  "responseFields": ["mode", "domain_id", "workspace", "total", "files"],
  "signature": "download_repowiki_files(request: RepoWikiDownloadRequest)",
  "businessPurpose": "Downloads a RepoWiki model manifest into the configured workspace.",
  "runtimePurpose": "Validates request parameters and dispatches the model download workflow.",
  "successSemantics": "The expected model files exist locally and the response points to the generated manifest.",
  "linkedKnowledge": ["docs/knowledge/interfaces-and-entrypoints.md", "docs/knowledge/key-flows.md"],
  "keywords": ["repowiki", "download", "workspace", "smileId"],
  "summary": "Handles RepoWiki manifest download requests and routes by workspace or Smile ID."
}
```

Example `objects.json` entry:

```json
{
  "name": "RepoWiki import batch",
  "stableId": "batch_id",
  "authority": "database table or manifest file that owns the batch state",
  "createdBy": ["app/api/repowiki_download.py"],
  "stateSource": "project-relative/path/to/state-owner",
  "states": ["created", "downloading", "published", "rag_completed", "failed"],
  "invariants": ["published does not imply RAG completed"],
  "evidence": [{ "type": "file", "ref": "app/api/repowiki_download.py", "symbol": "download_repowiki_files" }],
  "confidence": "confirmed"
}
```

Example `flows.json` entry:

```json
{
  "name": "RepoWiki download and publish",
  "trigger": "User or agent calls the RepoWiki download entry point",
  "entrypoint": "POST /aicodingkbmgr/repowiki/download",
  "components": ["API route", "download script", "workspace manifest", "RAG refresh trigger"],
  "stateChanges": ["download manifest is created", "model files are written", "publish status changes independently from RAG completion"],
  "successSemantics": "The requested model is downloaded and the publish/RAG statuses are separately observable.",
  "failureSemantics": "Partial RAG completion remains pending and must not be reported as full publication success.",
  "evidence": [{ "type": "file", "ref": "app/api/repowiki_download.py" }],
  "confidence": "confirmed"
}
```

`importance` is `critical`, `important`, or `supporting`. `evidenceStatus` and `confidence` are `confirmed`, `inferred`, or `pending`. A `critical` symbol or entry point must include `linkedKnowledge` pointing to one or more `docs/knowledge/*.md` pages. API route entries must include `line`, `method` or `methods`, `route`, and `requestFields`; use `aliases` for compatibility paths and `responseFields` when the public response shape is relevant. Dangerous operations must record acknowledgement fields, status preconditions, and safety consequences.

## 6. Proposal format

Return JSON only:

```json
{
  "title": "Initialize project knowledge",
  "summary": "What durable project understanding this proposal adds or corrects.",
  "changes": [
    {
      "targetPath": "docs/knowledge/project-overview.md",
      "operation": "create",
      "afterContent": "<full file content>"
    }
  ]
}
```

Operations are `create`, `update`, or `delete`. `afterContent` is required for create/update and omitted for delete. Include the full resulting file content, but only include files that changed. A proposal may target at most 50 files and 5 MiB total.

Allowed targets are:

- `docs/knowledge/**/*.md`
- `.taskboard/knowledge-index/*.json`
- `changelog.md` only for an actual completed project behavior change

## 7. Initial coverage

An initial proposal is complete when it lets a new maintainer answer, with evidence:

- What the project does, for whom, and how it is run and verified.
- Which components exist and where their responsibilities begin and end.
- Where the main entry points and change points are.
- How the central user and system flows cross those components.
- Which constraints, failure modes, and operating practices repeatedly matter.
- Which accepted designs and decisions remain relevant.
- Which concrete files, symbols, routes, scripts, docs, and recent changes are likely entry points for future questions.
- Which core objects own project state, where their authority lives, what projections or caches are downstream, and which object facts remain pending.
- Which critical entry points mutate or publish state, what success means, and which knowledge pages explain them.

Completeness does not mean documenting every file, class, endpoint, or historical Issue.

For `INIT`, the proposal must include the eight core pages listed in the page taxonomy and all eight pre-index files. `objects.json` and `flows.json` each need at least three entries for non-trivial projects. If the project genuinely has fewer objects or flows, submit a failure with the evidence instead of padding fake entries.

## 8. Incremental maintenance

- File sources use content revisions; Issue and comment sources use Taskboard versions.
- A stale source triggers impact analysis starting from that source and the pages that cite it.
- Issue/comment capture verifies the claimed result against the current project before proposing an update.
- Phase review scans for uncited new components, changed boundaries, missing completed decisions, and contradictions not caught by existing source links.
- Pre-index files should be updated when file locations, public symbols, route shapes, document summaries, or recent-change routing materially changes.
- Unrelated pages remain unchanged. Never rewrite every page merely to update timestamps or wording.
