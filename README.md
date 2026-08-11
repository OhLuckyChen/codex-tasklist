<p align="center">
  <img src="web/public/codex-app-icon.png" alt="Codex Taskboard icon" width="128" height="128">
</p>

<h1 align="center">Codex Taskboard</h1>

<p align="center">
  <strong>A local-first issue board for human and agent work inside Codex.</strong>
</p>

<p align="center">
  Manage projects, issues, comments, runtime sessions, and agent handoffs from one local workspace.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/OhLuckyChen/codex-tasklist/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/OhLuckyChen/codex-tasklist?style=social"></a>
  <img alt="Node.js >= 22.5" src="https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white">
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-2563eb">
  <img alt="Web and macOS" src="https://img.shields.io/badge/interface-Web%20%7C%20macOS-lightgrey">
</p>

> Codex Taskboard can run as a standalone web app or as a panel embedded in the Codex desktop app. It does not include a hosted collaboration backend: issues, attachments, logs, and runtime metadata are stored locally by default under `.data/`.

## Contents

- [Why it exists](#why-it-exists)
- [Workflow](#workflow)
- [Features](#features)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First use](#first-use)
- [Embed in Codex](#embed-in-codex)
- [Runtime sessions](#runtime-sessions)
- [taskctl CLI](#taskctl-cli)
- [Agent skill](#agent-skill)
- [Configuration](#configuration)
- [Data and security](#data-and-security)
- [Development and verification](#development-and-verification)
- [FAQ](#faq)
- [Docs and contributing](#docs-and-contributing)
- [License](#license)

## Why it exists

Codex Taskboard is designed to move attention away from watching every AI session and back to the state of the work itself.

In real projects, the same backlog is often handled by a human, Codex, Claude Code, and Oh My Pi in turn. Each tool produces its own sessions, logs, comments, and intermediate findings. When that context is scattered across different windows, the human still has to track which task is active, which one is blocked, which one needs review, and which one is already done.

Codex Taskboard collects that process around the task:

- manage backlog, in-progress, review, blocked, and done work by task state;
- connect each issue to its current and historical Codex, Claude Code, and Oh My Pi sessions;
- start follow-up sessions from an issue or a specific comment while keeping the handoff attached to the same task;
- use comments, attachments, and project knowledge to record intermediate decisions, evidence, and context;
- turn that accumulated process record into support for later changes, reviews, and continued development.

In short, it changes AI-assisted development from "a person chasing sessions" into "tools working around task state", reducing attention overhead while making cross-agent and cross-session work easier to manage and reuse.

## Workflow

1. Create or map a project to a local repository path.
2. Add an issue with labels, priority, assignee, due date, branch, and worktree context.
3. Start a Codex, Claude Code, or OMP session from the issue or from a review comment.
4. Let the agent update status, add comments, attach evidence, and link its runtime session.
5. Review the issue, send follow-up work when needed, or move it to done.

## Features

| Area | What is supported |
| --- | --- |
| Projects | Multi-project boards, cross-project overview, favorites, aliases, archive and restore. |
| Issues | `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`, and `archived` states; drafts, favorites, priorities, labels, assignees, due dates, and recurrence rules. |
| Comments and attachments | Markdown descriptions, issue comments, downloads, editing, deletion, and version conflict protection. |
| Relations | Parent, child, blocking, blocked-by, and related issue links. |
| Development context | Git branch, worktree path, and local project path mapping per issue. |
| Runtime sessions | Current and historical Codex, Claude Code, and Oh My Pi sessions, including comment-level session links and follow-up entry points. |
| Local automation | `taskctl` CLI plus the `manage-taskboard` skill for agents that need to claim work, comment, move status, and record session context. |
| Project knowledge | Local project knowledge proposals that can be reviewed into `docs/knowledge/`. |
| Realtime UI | Local HTTP API with Server-Sent Events for refreshing multiple browser windows or embedded Codex panels. |

## Screenshots

The screenshots below show the main workflow: keep attention on task state, open the board inside Codex, create issues with execution context, and preserve review evidence in the issue history.

| Task-state board | Embedded in Codex |
| --- | --- |
| <img src="linear-ui-proof.png" alt="Task-state board with backlog, todo, in progress, and done columns" width="420"> | <img src="injection-proof.png" alt="Codex Taskboard embedded in the Codex desktop app" width="420"> |

| Create issue with context | Issue detail with review context |
| --- | --- |
| <img src="linear-editor-proof.png" alt="New issue editor with status, priority, labels, and Codex task link" width="420"> | <img src="task-detail-embedded-proof.png" alt="Issue detail with comments and session context" width="420"> |

| Comments, evidence, and task metadata | Narrow issue detail |
| --- | --- |
| <img src="task-detail-proof.png" alt="Issue detail page with comments, properties, and activity timeline" width="420"> | <img src="task-detail-narrow-proof.png" alt="Narrow issue detail layout for focused review" width="420"> |

## How it works

```text
Web UI / Codex embedded panel / taskctl / manage-taskboard skill
                  |
                  v
          Local Node.js HTTP API + SSE
                  |
                  v
      SQLite + .data/attachments + project path mappings
                  |
                  v
       Codex / Claude Code / Oh My Pi local integrations
```

The Codex injector connects only to the local loopback CDP port and adds the Taskboard entry point plus task-jump behavior inside Codex. It does not modify, replace, or re-sign the official Codex app.

## Requirements

| Requirement | Required | Notes |
| --- | --- | --- |
| Node.js >= 22.5 | Yes | Used by the server, CLI, build, and tests. |
| npm | Yes | Dependency installation uses the lockfile through `npm ci`. |
| macOS | Optional | Required only for the Codex desktop launcher, Dock integration, and local terminal restore flows. |
| Codex desktop app | Optional | Needed for the embedded panel, task jump, and Codex session bridge. |
| `codex` CLI | Optional | Needed to create or follow up Codex sessions from issues. |
| `claude` CLI | Optional | Needed to start and restore Claude Code sessions. |
| `omp` CLI | Optional | Needed to start and restore Oh My Pi sessions. |

## Quick start

```bash
git clone https://github.com/OhLuckyChen/codex-tasklist.git
cd codex-tasklist
npm ci
npm run build:web
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

Open <http://127.0.0.1:47823>.

For development:

```bash
npm run dev
```

The Vite web app runs at <http://127.0.0.1:5173> and proxies API calls to the local Taskboard service.

## First use

1. Start the local service.
2. Create a project or map an existing project to a local repository path.
3. Create an issue and fill in status, priority, labels, branch, and worktree context.
4. Launch or attach a Codex, Claude Code, or OMP session from the issue.
5. Let the agent comment, attach evidence, move the issue to review, and keep follow-up sessions linked to the same issue.

## Embed in Codex

The recommended macOS setup is the Dock launcher:

```bash
./scripts/install-macos-launcher.sh
```

The installer:

- records the current Node.js path in `.data/node-path`;
- records the `codex` CLI path in `.data/codex-path` when available;
- installs a LaunchAgent that watches the local Codex CDP port and restores Taskboard;
- backs up the Dock configuration to `.data/com.apple.dock.before-codex-taskboard.plist`;
- replaces the Dock Codex entry with the Codex Taskboard launcher.

If Codex is already open, quit it once after installation and start it again from the new Dock icon.

You can also inject into a Codex instance that already exposes CDP:

```bash
npm run codex:inject -- --port 9229 --open
```

To pin explicit executables:

```bash
CODEX_TASKBOARD_NODE=/absolute/path/to/node \
CODEX_EXECUTABLE=/absolute/path/to/codex \
./scripts/install-macos-launcher.sh
```

## Runtime sessions

| Runtime | Supported flows |
| --- | --- |
| Codex | Start a Codex task from an issue, start from a comment, send a follow-up to the current task, attach or detach the current task, view current and historical tasks, and jump back to a Codex task by clicking its ID. |
| Claude Code | Start a Claude Code session from an issue or comment, record the Claude session ID, and resume an attached session through the local terminal. |
| Oh My Pi | Start an OMP session from an issue or comment, record the OMP session ID, and resume an attached session through the local terminal. |

Session links are stored at two levels. The issue-level current session is used for "continue this work now"; historical sessions preserve the runtime contexts that have touched the issue. Comments can also have their own sessions, which is useful when a review note needs a separate follow-up agent.

## taskctl CLI

Run commands from the repository:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My Project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

You can also run `npm link` to expose `taskctl` on your shell path. The full command reference lives in [`skills/manage-taskboard/references/cli.md`](skills/manage-taskboard/references/cli.md).

## Agent skill

Install the local skill for Codex:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/manage-taskboard" ~/.codex/skills/manage-taskboard
```

Use it in Codex:

```text
$manage-taskboard ISSUE-ID
```

The skill reads the latest issue, comments, and version number before writing back claims, comments, status moves, and session links through `taskctl`.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address. Use `127.0.0.1` for local-only standalone use. |
| `CODEX_TASKBOARD_PORT` | `47823` | HTTP server port. |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite database, attachments, logs, and runtime files. |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | API URL used by `taskctl`. |
| `CODEX_EXECUTABLE` | auto-detected | Codex CLI path. |
| `CLAUDE_EXECUTABLE` | auto-detected | Claude Code CLI path. |
| `OMP_EXECUTABLE` | auto-detected | Oh My Pi CLI path. |
| `CODEX_TASKBOARD_NODE` | auto-detected | Node.js path used by the macOS launcher. |

The default `0.0.0.0` bind address allows LAN devices to connect. The local service does not provide public account authentication, so do not expose it directly to the public internet.

## Data and security

- `.data/` is not committed to Git. It contains SQLite data, attachments, logs, installer-recorded executable paths, and Dock backups.
- Project path mappings are stored in SQLite project records.
- `~/.codex/skills` and `~/.claude/skills` are user-level agent integration directories and are used only when you install the skills.
- `/Applications/ChatGPT.app` is the default macOS location used by the Codex desktop integration; it is not required for the standalone web board.
- The repository no longer contains Cloudflare Worker, D1, R2, Wrangler, or hosted collaboration migration code.

## Development and verification

```bash
npm run check
```

This runs TypeScript type checking, a production web build, and the Node test suite.

You can run the pieces separately:

```bash
npm run typecheck
npm run build
npm test
```

## FAQ

| Question | Answer |
| --- | --- |
| `npm ci` says the Node version is unsupported. | Install Node.js 22.5 or newer. |
| The web app opens but cannot read project files. | Map the project to a local repository path in project settings, or run `taskctl project map PROJECT_ID --workspace-path /path/to/repo`. |
| Taskboard does not appear inside Codex. | Start Codex from the Codex Taskboard Dock icon, or manually run `npm run codex:inject -- --port 9229 --open`. |
| Clicking a Claude or OMP session does nothing. | Make sure the matching CLI is installed, or set `CLAUDE_EXECUTABLE` / `OMP_EXECUTABLE`. |
| Other devices on my LAN can access the board. | Start with `CODEX_TASKBOARD_HOST=127.0.0.1` for local-only access. |

## Docs and contributing

- [`changelog.md`](changelog.md) records notable changes.
- [`docs/knowledge/`](docs/knowledge/) contains local project knowledge pages.
- [`skills/manage-taskboard/references/cli.md`](skills/manage-taskboard/references/cli.md) documents the CLI used by the agent skill.

## License

This repository does not currently declare an open-source license. Until a license is added, all rights are reserved by default.
