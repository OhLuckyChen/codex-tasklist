<p align="center">
  <img src="web/public/codex-app-icon.png" alt="Codex Taskboard icon" width="128" height="128">
</p>

<h1 align="center">Codex Taskboard</h1>

<p align="center">
  <strong>A local taskboard that keeps Codex, Claude Code, and Oh My Pi work tied to issues.</strong>
</p>

<p align="center">
  Local-first · Standalone web app · Codex desktop panel · Multi-agent session handoff
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/OhLuckyChen/codex-tasklist/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/OhLuckyChen/codex-tasklist?style=social"></a>
  <img alt="Node.js >= 22.5" src="https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white">
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-2563eb">
  <img alt="Codex Claude OMP" src="https://img.shields.io/badge/runtimes-Codex%20%7C%20Claude%20Code%20%7C%20OMP-7c3aed">
  <img alt="No hosted backend" src="https://img.shields.io/badge/cloud-backend%20not%20included-lightgrey">
</p>

> Codex Taskboard is an unofficial local taskboard. It can run as a standalone web app or as a panel embedded in the Codex desktop app. The repository no longer ships a hosted collaboration backend and does not depend on Cloudflare Worker, D1, R2, Wrangler, or the maintainer's local machine paths. Issues, attachments, logs, and runtime metadata are stored locally under `.data/` by default.

## What problem does it solve?

AI coding work often spreads across several tools. One requirement may start in Codex, a review comment may be delegated to Claude Code, and a verification step may be handled by Oh My Pi. The human still has to remember:

- which task is active;
- which task is blocked;
- which review comment has already been assigned to an agent;
- which session should be continued;
- which historical sessions contain the decision or evidence;
- which project still has work waiting for review or cleanup.

Codex Taskboard keeps those tools centered on the issue instead of forcing people to chase conversations.

Each issue can store status, priority, labels, assignee, branch, worktree, local project mapping, comments, attachments, knowledge proposals, and current plus historical runtime sessions. You can start a new Codex / Claude Code / Oh My Pi session from an issue or from a specific comment, attach the current session back to the issue, and later jump back to the linked runtime context.

## Core features

### Taskboard

- Multi-project management: create projects, switch projects, set aliases, favorite projects, archive and restore projects.
- Cross-project focus: collect important work in the global task view and favorites view.
- Status workflow: backlog, todo, in progress, in review, blocked, done, canceled, and archived.
- Issue metadata: title, description, acceptance requirements, labels, priority, assignee, due date, recurrence, branch, worktree, and local project path mapping.
- Issue relations: parent, child, blocking, blocked-by, and related issue links.
- Version protection: issue and comment writes use version numbers to reduce accidental overwrites from multiple windows or agents.

### Agent session management

| Runtime | Supported flows |
| --- | --- |
| Codex | Start a Codex task from an issue; start a follow-up task from a comment; send a follow-up to the current task; attach or detach the current task; view current and historical tasks; click the task ID to jump back into Codex. |
| Claude Code | Start a Claude Code session from an issue or comment; record the Claude session ID; resume an attached session through the local terminal. |
| Oh My Pi / OMP | Start an OMP session from an issue or comment; record the OMP session ID; resume an attached session through the local terminal. |

Session links are stored at three useful levels:

- Issue current session: the main "continue this task" runtime context.
- Issue historical sessions: every runtime context that has touched the issue.
- Comment-level sessions: follow-up work tied to one review note, bug report, or clarification.

### Comments, attachments, and evidence

- Issue descriptions and comments support Markdown.
- Comments can hold review feedback, agent findings, verification notes, and follow-up instructions.
- Attachments can be uploaded, downloaded, and deleted.
- Activity history records status changes and important operations for later inspection.

### Codex desktop embedding

- Open Taskboard directly inside the Codex desktop app.
- Create a Codex task directly from Taskboard.
- Attach the current Codex task to an issue.
- Click a task ID from the issue detail page to jump back to the matching Codex task.
- On macOS, install the Dock launcher so Codex starts with Taskboard injection support.

The Codex injector only connects to the local loopback CDP port. It adds a Taskboard entry point and task-jump behavior to Codex pages. It does not modify, replace, or re-sign the official Codex app.

### Agent automation

The repository includes the `taskctl` CLI and the `manage-taskboard` skill so agents can work with the board while doing real implementation work:

- read projects, issues, comments, and version numbers;
- claim work;
- append comments and evidence;
- move issue status;
- attach Codex / Claude Code / OMP sessions;
- dispatch follow-up work from review comments.

### Project knowledge

Taskboard can turn issue discussions, comments, and implementation evidence into local project knowledge proposals. After review, accepted pages are written to `docs/knowledge/`. This is local project documentation, not a hosted knowledge service.

## Preview

The screenshots below come from the real local UI. Task titles, comments, names, and other sensitive content are pixelated; the interface itself is not redrawn or fabricated.

### Task-state board

View the same local Taskboard inside the Codex embedded panel. Issues are grouped by status, and cards keep priority, labels, and creation context visible for quick triage.

![Real task-state board with sensitive issue content pixelated](docs/screenshots/task-state-board.png)

### Standalone web board

Taskboard also runs as a normal web app. Without the Codex desktop app, projects, issues, comments, attachments, project knowledge, and CLI automation still work.

![Standalone web board with sensitive issue content pixelated](docs/screenshots/standalone-board.png)

### Create an issue

When creating an issue, you can fill in the title, description, status, priority, labels, and optional Codex task ID so execution context is attached from the beginning.

![Create issue dialog with sensitive background content pixelated](docs/screenshots/create-issue.png)

### Issue detail

The issue detail page centralizes description, activity, comments, properties, status, priority, labels, and project context. Agent results, evidence, and follow-up instructions are written back here.

![Issue detail page with sensitive content pixelated](docs/screenshots/task-detail.png)

### Issue detail inside Codex

When embedded in Codex, task state and execution context stay in the same work window, making it easier to start follow-up sessions from an issue or comment.

![Issue detail embedded in Codex with sensitive content pixelated](docs/screenshots/embedded-issue-detail.png)

## How it works

```text
Web UI / Codex embedded panel / taskctl / manage-taskboard skill
                  |
                  v
          Local Node.js HTTP API + Server-Sent Events
                  |
                  v
      SQLite + .data/attachments + project path mappings
                  |
                  v
       Codex / Claude Code / Oh My Pi local integrations
```

Typical workflow:

1. Create a project or map one to a local repository path.
2. Create an issue with description, acceptance requirements, labels, priority, branch, and worktree.
3. Start Codex / Claude Code / Oh My Pi from the issue or from a specific comment.
4. Let the agent write back results, evidence, blockers, and the runtime session ID.
5. Review the comments and changes; when rework is needed, start a follow-up session from the review comment.
6. Use historical sessions, activity, and comments to inspect the process, then move the issue to done.

## Requirements

| Requirement | Required | Purpose |
| --- | --- | --- |
| Node.js >= 22.5 | Yes | Runs the server, CLI, build scripts, and tests. |
| npm | Yes | Installs dependencies from the lockfile. |
| Git | Recommended | Clones the repository and helps manage branches and worktrees. |
| macOS | Optional | Needed only for the Codex desktop launcher, Dock integration, and local terminal restore flows. |
| Codex desktop app | Optional | Needed for the embedded Taskboard panel, task jump, and Codex session bridge. |
| `codex` CLI | Optional | Creates and continues Codex tasks from issues or comments. |
| `claude` CLI | Optional | Starts and resumes Claude Code sessions. |
| `omp` CLI | Optional | Starts and resumes Oh My Pi sessions. |

The minimal setup only needs Node.js and npm. Without Codex, Claude Code, or Oh My Pi, the board, issues, comments, attachments, project knowledge, and `taskctl` still work; only the matching runtime launch and resume actions are unavailable until the executable is installed or configured.

## Quick start: standalone web board

```bash
git clone https://github.com/OhLuckyChen/codex-tasklist.git
cd codex-tasklist
npm ci
npm run build:web
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

Open <http://127.0.0.1:47823>.

`CODEX_TASKBOARD_HOST=127.0.0.1` keeps the server local to your machine. The default bind address is `0.0.0.0`, which is useful for LAN access but should not be exposed directly to the public internet.

For development:

```bash
npm run dev
```

The Vite web app runs at <http://127.0.0.1:5173> and proxies API requests to the local Taskboard service.

## First-use checklist

1. Start the local service.
2. Create a project from the home page.
3. Map the project to a local repository path in project settings.
4. Create an issue with description, acceptance requirements, labels, priority, and development context.
5. If you want an agent to do the work, start Codex / Claude Code / OMP from the issue or a comment.
6. Ask the agent to write back comments, evidence, and status.
7. Review the result and move the issue to in review or done.

## Embed in the Codex desktop app

The recommended macOS setup is the Dock launcher:

```bash
./scripts/install-macos-launcher.sh
```

The installer will:

- verify that Node.js is >= 22.5;
- record the current Node.js path in `.data/node-path`;
- record the `codex` CLI path in `.data/codex-path` when available;
- install the `io.github.ohluckychen.codex-taskboard.supervisor` LaunchAgent;
- back up the current Dock configuration to `.data/com.apple.dock.before-codex-taskboard.plist`;
- replace the Dock Codex entry with the Codex Taskboard launcher.

If Codex is already open, quit it once after installation and start it again from the new Dock icon.

You can also inject into a Codex instance that already exposes CDP:

```bash
npm run codex:inject -- --port 9229 --open
```

To pin explicit executable paths:

```bash
CODEX_TASKBOARD_NODE=/absolute/path/to/node \
CODEX_EXECUTABLE=/absolute/path/to/codex \
./scripts/install-macos-launcher.sh
```

## Configure runtime executables

By default, Taskboard finds `codex`, `claude`, and `omp` through `PATH`. If your CLIs live somewhere else, configure them explicitly:

```bash
CODEX_EXECUTABLE=/absolute/path/to/codex \
CLAUDE_EXECUTABLE=/absolute/path/to/claude \
OMP_EXECUTABLE=/absolute/path/to/omp \
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm start
```

The macOS Dock launcher also reads `.data/node-path` and `.data/codex-path`. Those files are generated by the installer so GUI-launched apps do not depend on your shell startup files.

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

You can also expose `taskctl` on your shell path:

```bash
npm link
taskctl issue list --project my-project
```

The full command reference lives in [`skills/manage-taskboard/references/cli.md`](skills/manage-taskboard/references/cli.md).

## Install the agent skill

Install the local skill for Codex:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/manage-taskboard" ~/.codex/skills/manage-taskboard
```

Use it in Codex:

```text
$manage-taskboard ISSUE-ID
```

The skill reads the latest issue, comments, and version number before writing back claims, comments, status moves, and session links through `taskctl`. This keeps agents from updating an issue based only on stale conversation context.

## Environment variables

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

## Data boundaries and independent distribution

The repository is designed for local standalone use:

- It does not include Cloudflare Worker, D1, R2, Wrangler, or hosted collaboration migration code.
- It does not require the maintainer's local paths, private repository paths, or personal launcher scripts.
- Runtime data is written to `.data/` by default and is not committed to Git.
- Attachments are written to `.data/attachments`.
- Project path mappings are stored in SQLite project records.
- `~/.codex/skills` and `~/.claude/skills` are used only when the user explicitly installs agent skills.
- `/Applications/ChatGPT.app` is only used by the macOS Codex desktop integration; the standalone web board does not need it.

The local service does not include public account authentication. For remote access, use a trusted private network, SSH tunnel, or your own authenticated reverse proxy instead of exposing the default service directly to the public internet.

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
| `npm ci` says the Node version is unsupported. | Install Node.js 22.5 or newer, then run `npm ci` again. |
| The server starts but the page does not open. | Check the server port. The default URL is <http://127.0.0.1:47823>. |
| The port is already in use. | Start with `CODEX_TASKBOARD_PORT=another-port npm start`. |
| The web app opens but cannot read project files. | Map the project to a local repository path in project settings, or run `taskctl project map PROJECT_ID --workspace-path /path/to/repo`. |
| Taskboard does not appear inside Codex. | Start Codex from the Codex Taskboard Dock icon, or manually run `npm run codex:inject -- --port 9229 --open`. |
| Clicking a Codex task does not jump back to the session. | Make sure Codex was launched with CDP enabled and that the task ID is attached to the issue. |
| Clicking a Claude or OMP session does nothing. | Make sure the matching CLI is installed, or set `CLAUDE_EXECUTABLE` / `OMP_EXECUTABLE`. |
| Other devices on my LAN can access the board. | Start with `CODEX_TASKBOARD_HOST=127.0.0.1` for local-only access. |
| I want a different data directory. | Set `CODEX_TASKBOARD_DATA_DIR=/absolute/path/to/data`. |

## Documentation

- [`changelog.md`](changelog.md): notable changes.
- [`docs/knowledge/`](docs/knowledge/): local project knowledge pages.
- [`skills/manage-taskboard/references/cli.md`](skills/manage-taskboard/references/cli.md): CLI reference used by the agent skill.

## License

This repository does not currently declare an open-source license. Until a license is added, all rights are reserved by default.
