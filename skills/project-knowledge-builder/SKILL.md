---
name: project-knowledge-builder
description: Build, review, and incrementally update a Taskboard project's durable Markdown knowledge base from current code, configuration, tests, project documents, issues, and comments. Use when a Taskboard knowledge-initialization issue invokes this skill, when published project knowledge is stale, when an issue or its comments contain reusable knowledge, or when a phase review must produce a pending knowledge proposal without directly publishing files.
---

# Project Knowledge Builder

Build project knowledge as an evidence-backed, reviewable model of the project. Keep the project workspace read-only. Submit changes as a Taskboard pending proposal; never publish knowledge files directly.

This skill is self-contained in the Taskboard repository. Do not load a user-installed or machine-local skill. Resolve `<taskboard-root>` as the directory two levels above this `SKILL.md`.

Before reading or changing an Issue, comment, relation, or status, read the repository-bundled sibling `../manage-taskboard/SKILL.md` and its directly referenced CLI contract completely, then follow that workflow. Use `<taskboard-root>/cli/taskctl.mjs` and the local HTTP API for operations. `manage-taskboard` owns Taskboard state management; this skill owns knowledge analysis and proposal quality.

Read [references/knowledge-contract.md](references/knowledge-contract.md) completely before an initial scan, a phase review, or any proposal that creates a new page type.

## Quality bar

Good project knowledge:

- Describes current, durable project truth that will help a future developer navigate, change, diagnose, or operate the project.
- States scope and responsibility boundaries precisely and links every material claim to code, configuration, tests, project documents, an issue, or a comment.
- Separates confirmed facts and completed decisions from unfinished proposals, hypotheses, and questions.
- Explains important relationships and flows, not a file-by-file inventory or copied source code.
- Is organized by topic, updates an existing page when possible, and gives the reader a clear next place to look.
- Records source revisions so later checks can identify exactly what changed.
- Uses `changelog.md` only for actual completed project changes, never as a dumping ground for analysis notes.

Bad project knowledge includes:

- Raw code summaries, meeting notes, copied Issue descriptions, or copied comment timelines with no synthesis.
- Unverified plans presented as implemented behavior, or one person's suggestion presented as a decision.
- Temporary debugging details, progress chatter, personal opinions, machine-specific paths, secrets, tokens, or generated-agent process notes.
- Duplicate pages for the same concept, generic advice that is not project-specific, or details that become stale without helping a reader act.
- Claims without sources, source entries without revisions, and broad claims supported only by a narrow example.
- Mixing pending content into published pages before review.

## Source policy

Use these sources together; do not treat any one source as sufficient by default:

1. Current code, configuration, tests, and project-owned documentation establish implemented behavior.
2. Issue descriptions establish requested scope, constraints, and acceptance criteria, but not completion.
3. Comments are knowledge candidates only when they contain a resolved decision, durable constraint, verified root cause, reusable procedure, confirmed behavior, or acceptance evidence.
4. Issue status helps classify certainty. `done` plus supporting implementation or verification may support confirmed knowledge. `todo`, `in_progress`, `blocked`, and unresolved `in_review` content stays pending unless independently proven by current project evidence.
5. Existing published knowledge is the structure to update, not an authority that overrides current evidence.

Discard acknowledgements, scheduling notes, repeated status updates, speculative options with no decision, and comments whose only value is local to the finished conversation. Summarize useful comment sequences into the resulting fact or decision; never reproduce the conversation.

## Execution workflow

### 1. Resolve and claim the initialization Issue

Extract the Issue identifier from the task prompt. From any working directory, run Taskboard CLI commands through the repository:

```bash
npm --prefix <taskboard-root> run taskctl -- issue get <identifier> --json
npm --prefix <taskboard-root> run taskctl -- comment list <identifier> --json
```

Verify that the Issue belongs to the project being analyzed and that its description requests this skill. If its status is `todo`, move it to `in_progress` using its latest version. Read all Issue comments before analysis. Keep all CLI writes attributed to the current Codex task through the environment supplied by Codex.

### 2. Verify the project boundary

Run `pwd` and resolve its real path. It must match the Issue's mapped project directory. Stop and report the mismatch instead of scanning another directory.

Treat that project directory as read-only. Do not edit, create, delete, format, build, install dependencies, or generate artifacts inside it. Reading Git metadata and running read-only discovery commands is allowed. Never switch to a similarly named directory.

### 3. Select the mode

- `INIT`: no published knowledge exists. Inspect the complete project and relevant Taskboard history, then propose the initial coherent knowledge set.
- `UPDATE`: start with changed sources or stale pages, trace their downstream impact, and propose only affected updates.
- `ISSUE`: analyze the selected Issue and comments, verify them against current project evidence, and propose only durable knowledge.
- `REVIEW`: compare the whole current project and completed Issue history with published knowledge, then fill gaps and correct contradictions.

The initialization Issue uses `INIT`.

### 4. Collect evidence

For `INIT`, inspect at minimum:

- Root structure, entry points, manifests, build/run configuration, primary modules, persistence and external boundaries.
- Tests and verification scripts that reveal supported behavior and invariants.
- Existing project documentation and `changelog.md`.
- Existing `docs/knowledge/`, if present, to avoid duplicate topics.
- All non-archived Issues in the current Taskboard project and their comments. Prioritize completed and reviewed work, but retain unresolved proposals only as proposal context rather than facts.

Follow imports, calls, routes, schemas, and tests deeply enough to support each material statement. Mark a fact as pending when evidence conflicts or remains incomplete.

### 5. Design the proposal

Prefer a small coherent set of topic pages over many shallow pages. The initial set normally covers project overview, architecture, code map, key flows, and engineering notes; create decision, design, flow, or guide pages only when the evidence contains durable content for them.

Before proposing each page, check:

- What future question does this page answer?
- Which exact evidence supports it?
- Is the content confirmed, completed, and current?
- Does an existing page already own this topic?
- Would the content remain useful after the current Issue is closed?

Do not propose an empty category merely to fill the directory shape.

### 6. Create a persistent pending proposal

Create a knowledge run against the local Taskboard service:

```http
POST http://127.0.0.1:47823/api/local/projects/<project-id>/knowledge-runs
Content-Type: application/json

{
  "workspacePath": "<verified-real-project-root>",
  "sourceType": "project_scan",
  "sourceSnapshot": {
    "trigger": "knowledge-initialization-issue",
    "issueIdentifier": "<identifier>",
    "capturedAt": "<ISO-8601>"
  },
  "developmentContext": null,
  "persist": true
}
```

For `UPDATE`, `ISSUE`, and `REVIEW`, use `stale_refresh`, `issue`, and `project_review` respectively and include the changed source revisions or Issue/comment versions in `sourceSnapshot`.

The response contains a run-specific `instruction`, callback URL, and one-time token. Follow that instruction exactly. Analyze the verified project directly, produce the full proposal JSON, and POST it to the callback. The callback validates the changes and persists them as a `ready` proposal. Do not call the publish endpoint.

### 7. Verify and hand off

Confirm the callback returned `{"ok":true}`. Then verify through Taskboard that the project has a `ready` knowledge proposal. The proposal must contain only changed files and every target must be `docs/knowledge/**/*.md` or, for a completed behavior change only, `changelog.md`.

Add a concise Issue comment containing:

- Evidence scope inspected.
- Proposed pages and why they are durable.
- Items deliberately left pending or excluded.
- Verification that the proposal is visible and unpublished.

Move the initialization Issue to `in_review` using its latest version. Never mark it `done`; user confirmation is required.

## Failure behavior

Submit a specific error to the run callback when the workspace is wrong, required sources cannot be read, evidence is insufficient for a coherent proposal, or the callback cannot validate the result. Keep the Issue `in_progress`, add the exact failure and next actionable step as a comment, and do not fabricate a partial success.
