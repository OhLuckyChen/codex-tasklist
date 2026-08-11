# Project knowledge contract

## Contents

1. Published and pending boundary
2. Page taxonomy
3. Page format
4. Proposal format
5. Initial coverage
6. Incremental maintenance

## 1. Published and pending boundary

Published knowledge lives only in the analyzed project's `docs/knowledge/` and its existing `changelog.md`. It contains confirmed current facts and completed decisions.

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
- `docs/knowledge/designs/<topic>.md`: a technical design that is implemented or explicitly accepted and still useful.
- `docs/knowledge/decisions/<topic>.md`: a durable decision, alternatives considered, status, and consequences.
- `docs/knowledge/flows/<topic>.md`: a detailed specialist flow that would overload `key-flows.md`.
- `docs/knowledge/guides/<topic>.md`: reusable development, troubleshooting, or operational procedure.
- `changelog.md`: chronological record of actual completed project changes. It is not a knowledge index, proposal log, or work journal.

Do not create a page when its useful content fits an existing owner page. Do not create empty category directories.

## 3. Page format

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

## 4. Proposal format

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

## 5. Initial coverage

An initial proposal is complete when it lets a new maintainer answer, with evidence:

- What the project does, for whom, and how it is run and verified.
- Which components exist and where their responsibilities begin and end.
- Where the main entry points and change points are.
- How the central user and system flows cross those components.
- Which constraints, failure modes, and operating practices repeatedly matter.
- Which accepted designs and decisions remain relevant.

Completeness does not mean documenting every file, class, endpoint, or historical Issue.

## 6. Incremental maintenance

- File sources use content revisions; Issue and comment sources use Taskboard versions.
- A stale source triggers impact analysis starting from that source and the pages that cite it.
- Issue/comment capture verifies the claimed result against the current project before proposing an update.
- Phase review scans for uncited new components, changed boundaries, missing completed decisions, and contradictions not caught by existing source links.
- Unrelated pages remain unchanged. Never rewrite every page merely to update timestamps or wording.
