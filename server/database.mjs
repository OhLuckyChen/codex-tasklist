import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    runtime: row.runtime ?? "codex",
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at ?? row.updated_at,
    startDate: row.start_date,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function connectorFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime,
    baseUrl: row.base_url ?? null,
    apiKey: row.api_key ?? null,
    model: row.model ?? null,
    customHeaders: row.custom_headers ? JSON.parse(row.custom_headers) : null,
    executable: row.executable ?? null,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function knowledgeChangeFromRow(row) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    targetPath: row.target_path,
    operation: row.operation,
    baseDigest: row.base_digest,
    beforeContent: row.before_content,
    afterContent: row.after_content,
    sortOrder: row.sort_order,
  };
}

function knowledgeProposalFromRow(row, changes = []) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourceType: row.source_type,
    sourceSnapshot: JSON.parse(row.source_snapshot),
    developmentContext: row.development_context_type === "worktree"
      ? { type: "worktree", branch: row.development_branch }
      : row.development_context_type === "branch"
        ? { type: "branch", branch: row.development_branch }
        : null,
    status: row.status,
    summary: row.summary,
    error: row.error,
    creator: {
      type: row.creator_type,
      id: row.creator_id,
      name: row.creator_name,
    },
    publisher: row.publisher_id
      ? {
          type: row.publisher_type,
          id: row.publisher_id,
          name: row.publisher_name,
        }
      : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    changes,
  };
}

function projectPrefix(projectId) {
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (prefix || "TASK").slice(0, 12);
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'archived'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        runtime TEXT NOT NULL DEFAULT 'codex' CHECK (runtime IN ('codex', 'claude', 'omp')),
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status_changed_at TEXT NOT NULL,
        start_date TEXT
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS task_threads (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'codex' CHECK (runtime IN ('codex', 'claude', 'omp')),
        linked_at TEXT NOT NULL,
        PRIMARY KEY (task_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN (
          'project_scan', 'issue', 'comments', 'question', 'stale_refresh', 'project_review'
        )),
        source_snapshot TEXT NOT NULL DEFAULT '{}',
        development_context_type TEXT CHECK (
          development_context_type IS NULL OR development_context_type IN ('branch', 'worktree')
        ),
        development_branch TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'generating', 'ready', 'published', 'rejected', 'failed'
        )),
        summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        creator_type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        publisher_type TEXT,
        publisher_id TEXT,
        publisher_name TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );

      CREATE INDEX IF NOT EXISTS knowledge_proposals_project_status
        ON knowledge_proposals(project_id, status, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS knowledge_proposal_changes (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES knowledge_proposals(id) ON DELETE CASCADE,
        target_path TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
        base_digest TEXT,
        before_content TEXT,
        after_content TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(proposal_id, target_path)
      );

      CREATE INDEX IF NOT EXISTS knowledge_proposal_changes_proposal
        ON knowledge_proposal_changes(proposal_id, sort_order, id);

    `);

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    if (!taskColumns.some((column) => column.name === "runtime")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'codex'");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.#migrateArchivedStatus();
    const runtimeCheckColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!runtimeCheckColumns.some((column) => column.name === "runtime")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'codex'");
    }
    this.#migrateRuntimeCheckConstraint();
    const statusTimestampColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!statusTimestampColumns.some((column) => column.name === "status_changed_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN status_changed_at TEXT");
      this.database.exec("UPDATE tasks SET status_changed_at = updated_at WHERE status_changed_at IS NULL");
    }
    const startDateColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!startDateColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'omp')),
        base_url TEXT,
        api_key TEXT,
        model TEXT,
        custom_headers TEXT,
        executable TEXT,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS connectors_runtime_default
        ON connectors(runtime) WHERE is_default = 1;

      CREATE INDEX IF NOT EXISTS connectors_runtime_sort
        ON connectors(runtime, sort_order, created_at);
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const taskThreadColumns = this.database.prepare("PRAGMA table_info(task_threads)").all();
    if (
      taskThreadColumns.some((column) => column.name === "created_at")
      && !taskThreadColumns.some((column) => column.name === "linked_at")
    ) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          WHERE task_threads.task_id = tasks.id
          ORDER BY
            CASE WHEN task_threads.thread_id IN (
              SELECT comments.thread_id FROM comments
              WHERE comments.task_id = task_threads.task_id
            ) THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL;
        ALTER TABLE task_threads RENAME TO legacy_task_threads;
        CREATE TABLE task_threads (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          runtime TEXT NOT NULL DEFAULT 'codex' CHECK (runtime IN ('codex', 'claude', 'omp')),
          linked_at TEXT NOT NULL,
          PRIMARY KEY (task_id, thread_id)
        );
        INSERT INTO task_threads (task_id, thread_id, runtime, linked_at)
        SELECT
          legacy_task_threads.task_id,
          legacy_task_threads.thread_id,
          CASE WHEN legacy_task_threads.thread_id = tasks.thread_id THEN tasks.runtime ELSE 'codex' END,
          legacy_task_threads.created_at
        FROM legacy_task_threads
        JOIN tasks ON tasks.id = legacy_task_threads.task_id;
        DROP TABLE legacy_task_threads;
      `);
    }
    const migratedTaskThreadColumns = this.database.prepare("PRAGMA table_info(task_threads)").all();
    if (!migratedTaskThreadColumns.some((column) => column.name === "runtime")) {
      this.database.exec("ALTER TABLE task_threads ADD COLUMN runtime TEXT NOT NULL DEFAULT 'codex'");
      this.database.exec(`
        UPDATE task_threads
        SET runtime = (
          SELECT tasks.runtime FROM tasks
          WHERE tasks.id = task_threads.task_id
            AND tasks.thread_id = task_threads.thread_id
        )
        WHERE EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.id = task_threads.task_id
            AND tasks.thread_id = task_threads.thread_id
        )
      `);
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS task_threads_task_linked
        ON task_threads(task_id, linked_at DESC, thread_id);
      INSERT OR IGNORE INTO task_threads (task_id, thread_id, runtime, linked_at)
      SELECT id, thread_id, runtime, updated_at FROM tasks WHERE thread_id IS NOT NULL;
      INSERT OR IGNORE INTO task_threads (task_id, thread_id, runtime, linked_at)
      SELECT task_id, thread_id, 'codex', updated_at FROM comments WHERE thread_id IS NOT NULL;
    `);

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', 'Local', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
  }

  close() {
    this.database.close();
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  #migrateArchivedStatus() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (tasksSql.includes("'archived'")) {
      this.database.exec(`
        UPDATE tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'
      `);
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_archived_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'archived'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          creator_type TEXT NOT NULL DEFAULT 'user',
          creator_id TEXT NOT NULL DEFAULT 'local-user',
          creator_name TEXT NOT NULL DEFAULT '本地用户',
          creator_avatar_url TEXT,
          assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
          assignee_id TEXT NOT NULL DEFAULT 'local-user',
          assignee_name TEXT NOT NULL DEFAULT '本地用户',
          assignee_avatar_url TEXT,
          workflow_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_archived_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description,
          CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END,
          priority, labels, sort_order, thread_id,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_archived_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Archived status migration produced a foreign key violation in '${violation.table}'`);
    }
  }
  #migrateRuntimeCheckConstraint() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    // If the table SQL has no runtime CHECK constraint at all (column was
    // added via ALTER TABLE), or it already includes 'omp', nothing to do.
    if (!tasksSql.includes("CHECK (runtime IN")) return;
    if (tasksSql.includes("'omp'")) return;

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_runtime_check_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'archived'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          runtime TEXT NOT NULL DEFAULT 'codex' CHECK (runtime IN ('codex', 'claude', 'omp')),
          creator_type TEXT NOT NULL DEFAULT 'user',
          creator_id TEXT NOT NULL DEFAULT 'local-user',
          creator_name TEXT NOT NULL DEFAULT '本地用户',
          creator_avatar_url TEXT,
          assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
          assignee_id TEXT NOT NULL DEFAULT 'local-user',
          assignee_name TEXT NOT NULL DEFAULT '本地用户',
          assignee_avatar_url TEXT,
          workflow_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_runtime_check_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, runtime, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, runtime, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_runtime_check_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Runtime CHECK constraint migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.status != 'archived'
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.id, input.name, input.workspacePath, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.status != 'archived'
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  setProjectWorkspace(id, workspacePath) {
    const result = this.database.prepare(`
      UPDATE projects
      SET workspace_path = ?, updated_at = ?
      WHERE id = ?
    `).run(workspacePath, now(), id);
    if (result.changes === 0) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    return this.getProject(id);
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listConnectors() {
    return this.database.prepare(`
      SELECT * FROM connectors
      ORDER BY runtime, sort_order, created_at
    `).all().map(connectorFromRow);
  }

  getConnector(id) {
    const row = this.database.prepare("SELECT * FROM connectors WHERE id = ?").get(id);
    return row ? connectorFromRow(row) : null;
  }

  getDefaultConnector(runtime) {
    const row = this.database.prepare(
      "SELECT * FROM connectors WHERE runtime = ? AND is_default = 1",
    ).get(runtime);
    return row ? connectorFromRow(row) : null;
  }

  #requireConnector(id) {
    const connector = this.getConnector(id);
    if (!connector) {
      throw new ApiError(404, "CONNECTOR_NOT_FOUND", `Connector '${id}' does not exist`);
    }
    return connector;
  }

  #connectorVersion(current, version) {
    if (version !== undefined && version !== null && current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Connector was changed by another client", {
        expectedVersion: version,
        actualVersion: current.version,
      });
    }
  }

  createConnector(input) {
    const id = randomUUID();
    const timestamp = now();
    const runtime = input.runtime;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.isDefault) {
        this.database.prepare(
          "UPDATE connectors SET is_default = 0, updated_at = ? WHERE runtime = ? AND is_default = 1",
        ).run(timestamp, runtime);
      }
      this.database.prepare(`
        INSERT INTO connectors (
          id, name, runtime, base_url, api_key, model, custom_headers,
          executable, is_default, sort_order, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        input.name,
        runtime,
        input.baseUrl ?? null,
        input.apiKey ?? null,
        input.model ?? null,
        input.customHeaders ? JSON.stringify(input.customHeaders) : null,
        input.executable ?? null,
        input.isDefault ? 1 : 0,
        input.sortOrder ?? 0,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getConnector(id);
  }

  updateConnector(id, version, changes) {
    const current = this.#requireConnector(id);
    this.#connectorVersion(current, version);
    const timestamp = now();
    const columns = {
      name: "name",
      baseUrl: "base_url",
      apiKey: "api_key",
      model: "model",
      executable: "executable",
      sortOrder: "sort_order",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "customHeaders") {
        assignments.push("custom_headers = ?");
        values.push(value ? JSON.stringify(value) : null);
        continue;
      }
      if (key === "isDefault") {
        continue;
      }
      if (columns[key]) {
        assignments.push(`${columns[key]} = ?`);
        values.push(value ?? null);
      }
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (Object.hasOwn(changes, "isDefault")) {
        if (changes.isDefault) {
          this.database.prepare(
            "UPDATE connectors SET is_default = 0, updated_at = ? WHERE runtime = ? AND is_default = 1 AND id != ?",
          ).run(timestamp, current.runtime, id);
          assignments.push("is_default = 1");
        } else {
          assignments.push("is_default = 0");
        }
      }
      if (assignments.length > 0) {
        assignments.push("version = version + 1", "updated_at = ?");
        values.push(timestamp);
        values.push(id, current.version);
        const result = this.database.prepare(
          `UPDATE connectors SET ${assignments.join(", ")} WHERE id = ? AND version = ?`,
        ).run(...values);
        if (result.changes !== 1) {
          throw new ApiError(409, "VERSION_CONFLICT", "Connector was changed by another client", {
            expectedVersion: current.version,
            actualVersion: null,
          });
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getConnector(id);
  }

  setDefaultConnector(id, version) {
    const current = this.#requireConnector(id);
    this.#connectorVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "UPDATE connectors SET is_default = 0, updated_at = ? WHERE runtime = ? AND is_default = 1 AND id != ?",
      ).run(timestamp, current.runtime, id);
      const result = this.database.prepare(`
        UPDATE connectors
        SET is_default = 1, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, id, current.version);
      if (result.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", "Connector was changed by another client", {
          expectedVersion: current.version,
          actualVersion: null,
        });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getConnector(id);
  }

  deleteConnector(id, version) {
    const current = this.#requireConnector(id);
    this.#connectorVersion(current, version);
    const result = this.database.prepare(
      "DELETE FROM connectors WHERE id = ? AND version = ?",
    ).run(id, current.version);
    if (result.changes !== 1) {
      throw new ApiError(409, "VERSION_CONFLICT", "Connector was changed by another client", {
        expectedVersion: current.version,
        actualVersion: null,
      });
    }
    return { id };
  }

  listKnowledgeProposals(projectId, status) {
    const rows = this.database.prepare(`
      SELECT * FROM knowledge_proposals
      WHERE project_id = ?
        AND (? IS NULL OR status = ?)
      ORDER BY
        CASE status
          WHEN 'ready' THEN 1
          WHEN 'generating' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'published' THEN 4
          WHEN 'rejected' THEN 5
        END,
        updated_at DESC,
        id DESC
    `).all(projectId, status ?? null, status ?? null);
    return rows.map((row) => knowledgeProposalFromRow(row, this.#knowledgeChanges(row.id)));
  }

  knowledgeSourceVersions(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const versions = {};
    const tasks = this.database.prepare(`
      SELECT id, identifier, version FROM tasks WHERE project_id = ?
    `).all(projectId);
    for (const task of tasks) {
      versions[`issue:${task.id}`] = task.version;
      versions[`issue:${task.identifier}`] = task.version;
    }
    const comments = this.database.prepare(`
      SELECT comments.id, comments.version
      FROM comments
      INNER JOIN tasks ON tasks.id = comments.task_id
      WHERE tasks.project_id = ?
    `).all(projectId);
    for (const comment of comments) versions[`comment:${comment.id}`] = comment.version;
    return versions;
  }

  getKnowledgeProposal(id) {
    const row = this.database.prepare("SELECT * FROM knowledge_proposals WHERE id = ?").get(id);
    return row ? knowledgeProposalFromRow(row, this.#knowledgeChanges(id)) : null;
  }

  createKnowledgeProposal(input) {
    const project = this.getProject(input.projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
    }
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const context = input.developmentContext ?? null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO knowledge_proposals (
          id, project_id, title, source_type, source_snapshot,
          development_context_type, development_branch, status, summary, error,
          creator_type, creator_id, creator_name, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        input.projectId,
        input.title,
        input.sourceType,
        JSON.stringify(input.sourceSnapshot ?? {}),
        context?.type ?? null,
        context?.branch ?? null,
        input.status ?? "ready",
        input.summary ?? "",
        input.error ?? null,
        input.actor.type,
        input.actor.id,
        input.actor.name,
        timestamp,
        timestamp,
      );
      this.#replaceKnowledgeChanges(id, input.changes ?? []);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getKnowledgeProposal(id);
  }

  updateKnowledgeProposal(id, expectedVersion, changes, actor) {
    const current = this.getKnowledgeProposal(id);
    if (!current) {
      throw new ApiError(404, "KNOWLEDGE_PROPOSAL_NOT_FOUND", `Knowledge proposal '${id}' does not exist`);
    }
    if (current.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Knowledge proposal was changed by another client", {
        expectedVersion,
        actualVersion: current.version,
      });
    }
    const nextStatus = changes.status ?? current.status;
    const allowedTransitions = {
      generating: new Set(["generating", "ready", "failed", "rejected"]),
      failed: new Set(["failed", "generating", "ready", "rejected"]),
      ready: new Set(["ready", "published", "rejected"]),
      published: new Set(["published"]),
      rejected: new Set(["rejected"]),
    };
    if (!allowedTransitions[current.status]?.has(nextStatus)) {
      throw new ApiError(409, "INVALID_PROPOSAL_TRANSITION", `Cannot change proposal from ${current.status} to ${nextStatus}`);
    }
    const timestamp = now();
    const publisher = nextStatus === "published" ? actor : current.publisher;
    const publishedAt = nextStatus === "published" ? (current.publishedAt ?? timestamp) : current.publishedAt;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE knowledge_proposals
        SET title = ?, summary = ?, status = ?, error = ?,
            publisher_type = ?, publisher_id = ?, publisher_name = ?, published_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        changes.title ?? current.title,
        changes.summary ?? current.summary,
        nextStatus,
        Object.hasOwn(changes, "error") ? changes.error : current.error,
        publisher?.type ?? null,
        publisher?.id ?? null,
        publisher?.name ?? null,
        publishedAt,
        timestamp,
        id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", "Knowledge proposal was changed by another client");
      }
      if (changes.changes) this.#replaceKnowledgeChanges(id, changes.changes);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getKnowledgeProposal(id);
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
          WHEN 'archived' THEN 8
        END,
        sort_order,
        created_at,
        id
    `;
    return this.database.prepare(sql).all(...values).map((row) => this.#taskWithRelations(row));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    return row ? this.#taskWithRelations(row) : null;
  }

  listTaskThreadRuntimeRecords(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("tasks.project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("tasks.status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("tasks.archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("tasks.archived_at IS NOT NULL");
    }

    return this.database.prepare(`
      SELECT task_threads.task_id, task_threads.thread_id, task_threads.runtime, tasks.thread_id AS current_thread_id
      FROM task_threads
      JOIN tasks ON tasks.id = task_threads.task_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    `).all(...values);
  }

  getTaskThreadRuntimeRecords(id) {
    return this.database.prepare(`
      SELECT task_threads.task_id, task_threads.thread_id, task_threads.runtime, tasks.thread_id AS current_thread_id
      FROM task_threads
      JOIN tasks ON tasks.id = task_threads.task_id
      WHERE tasks.id = ? OR tasks.identifier = ?
    `).all(id, id);
  }

  updateTaskThreadRuntime(taskId, threadId, runtime) {
    this.database.prepare(`
      UPDATE task_threads
      SET runtime = ?
      WHERE task_id = ? AND thread_id = ?
    `).run(runtime, taskId, threadId);
    this.database.prepare(`
      UPDATE tasks
      SET runtime = ?
      WHERE id = ? AND thread_id = ?
    `).run(runtime, taskId, threadId);
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT id, next_task_number FROM projects WHERE id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const number = project.next_task_number;
      const identifier = `${projectPrefix(project.id)}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT COALESCE(MAX(sort_order), 0) AS maximum
          FROM tasks
          WHERE project_id = ? AND status = ?
        `).get(input.projectId, input.status);
        sortOrder = row.maximum + 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = next_task_number + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.projectId);
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, runtime, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at, status_changed_at, start_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        input.threadId ?? null,
        input.runtime ?? "codex",
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.workflowId,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        input.status === "archived" ? timestamp : null,
        timestamp,
        timestamp,
        timestamp,
        input.startDate ?? null,
      );
      this.#linkTaskThread(id, input.threadId, timestamp, input.runtime ?? "codex");
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      dueDate: "due_date",
      startDate: "start_date",
      runtime: "runtime",
    };
    const assignments = [];
    const values = [];
    const timestamp = now();
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status")) {
      assignments.push("archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE NULL END");
      values.push(changes.status, timestamp);
      if (changes.status !== current.status) {
        assignments.push("status_changed_at = ?");
        values.push(timestamp);
      }
    }
    if (threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(threadId);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#linkTaskThread(current.id, threadId, timestamp, changes.runtime ?? current.runtime);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  unlinkTaskThread(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const linked = this.database.prepare(`
      SELECT 1 FROM task_threads WHERE task_id = ? AND thread_id = ?
    `).get(current.id, threadId);
    if (!linked) {
      throw new ApiError(404, "THREAD_LINK_NOT_FOUND", "This conversation is not linked to the issue");
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET
          thread_id = CASE WHEN thread_id = ? THEN NULL ELSE thread_id END,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND version = ?
      `).run(threadId, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.prepare(`
        UPDATE comments
        SET thread_id = NULL, version = version + 1, updated_at = ?
        WHERE task_id = ? AND thread_id = ?
      `).run(timestamp, current.id, threadId);
      this.database.prepare(`
        DELETE FROM task_threads WHERE task_id = ? AND thread_id = ?
      `).run(current.id, threadId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?,
            archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE NULL END,
            status_changed_at = CASE WHEN status != ? THEN ? ELSE status_changed_at END,
            thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, status, timestamp, status, timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#linkTaskThread(current.id, threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  transferTask(id, version, projectId, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.projectId === projectId) {
      throw new ApiError(409, "TASK_ALREADY_IN_PROJECT", "Issue already belongs to the target project");
    }

    const detachedRelations = [
      ...(current.relations.parent
        ? [{ type: "parent", task: current.relations.parent }]
        : []),
      ...current.relations.subIssues.map((task) => ({ type: "sub_issue", task })),
      ...current.relations.blockedBy.map((task) => ({ type: "blocked_by", task })),
      ...current.relations.blocks.map((task) => ({ type: "blocks", task })),
      ...current.relations.related.map((task) => ({ type: "related", task })),
    ];
    const timestamp = now();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const targetProject = this.database.prepare(`
        SELECT id, next_task_number FROM projects WHERE id = ?
      `).get(projectId);
      if (!targetProject) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const identifier = `${projectPrefix(targetProject.id)}-${targetProject.next_task_number}`;
      const sortOrder = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next_order
        FROM tasks
        WHERE project_id = ? AND status = ? AND id != ?
      `).get(projectId, current.status, current.id).next_order;

      this.database.prepare(`
        DELETE FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
      `).run(current.id, current.id);
      this.database.prepare(`
        UPDATE projects
        SET next_task_number = next_task_number + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, projectId);
      this.database.prepare(`
        UPDATE projects SET updated_at = ? WHERE id = ?
      `).run(timestamp, current.projectId);
      const result = this.database.prepare(`
        UPDATE tasks
        SET identifier = ?, project_id = ?, sort_order = ?,
            thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        identifier,
        projectId,
        sortOrder,
        threadId ?? null,
        timestamp,
        current.id,
        version,
      );
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#linkTaskThread(current.id, threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      task: this.getTask(current.id),
      previousProjectId: current.projectId,
      previousIdentifier: current.identifier,
      detachedRelations,
    };
  }

  archiveTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    const sortOrder = this.database.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next_order
      FROM tasks WHERE project_id = ? AND status = 'archived' AND id != ?
    `).get(current.projectId, current.id).next_order;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'archived', sort_order = ?, archived_at = COALESCE(archived_at, ?),
            status_changed_at = CASE WHEN status != 'archived' THEN ? ELSE status_changed_at END,
            thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(sortOrder, timestamp, timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#linkTaskThread(current.id, threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.status !== "archived") {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const sortOrder = this.database.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next_order
      FROM tasks WHERE project_id = ? AND status = 'todo' AND id != ?
    `).get(current.projectId, current.id).next_order;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'todo', sort_order = ?, archived_at = NULL,
            status_changed_at = ?,
            thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(sortOrder, timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#linkTaskThread(current.id, threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  addTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, now());
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    const id = randomUUID();
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        task.id,
        input.body,
        input.threadId ?? null,
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
      );
      this.#linkTaskThread(task.id, input.threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE comments
        SET
          body = ?,
          thread_id = CASE WHEN ? = 1 THEN ? ELSE thread_id END,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND version = ?
      `).run(body, threadId !== undefined ? 1 : 0, threadId ?? null, timestamp, id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.#linkTaskThread(current.taskId, threadId, timestamp);
      if (threadId === null && current.threadId) {
        this.database.prepare(`
          DELETE FROM task_threads
          WHERE task_id = ? AND thread_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM tasks WHERE id = ? AND thread_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM comments WHERE task_id = ? AND thread_id = ?
            )
        `).run(
          current.taskId,
          current.threadId,
          current.taskId,
          current.threadId,
          current.taskId,
          current.threadId,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deleteComment(id, version, threadId) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        DELETE FROM comments WHERE id = ? AND version = ?
      `).run(id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.#linkTaskThread(current.taskId, threadId, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const threadRows = this.database.prepare(`
      SELECT thread_id, runtime
      FROM task_threads
      WHERE task_id = ?
      ORDER BY CASE WHEN thread_id = ? THEN 0 ELSE 1 END, linked_at DESC, thread_id DESC
    `).all(task.id, task.threadId);
    task.threadIds = threadRows.map((item) => item.thread_id);
    task.threadRuntimes = Object.fromEntries(
      threadRows.map((item) => [item.thread_id, item.runtime ?? "codex"]),
    );
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #touchTask(id, version, threadId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE tasks
      SET thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(threadId ?? null, timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
    this.#linkTaskThread(id, threadId, timestamp);
  }

  #linkTaskThread(taskId, threadId, linkedAt, runtime = "codex") {
    if (threadId === undefined || threadId === null) return;
    this.database.prepare(`
      INSERT INTO task_threads (task_id, thread_id, runtime, linked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, thread_id) DO UPDATE SET
        runtime = excluded.runtime,
        linked_at = excluded.linked_at
    `).run(taskId, threadId, runtime, linkedAt);
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }

  #knowledgeChanges(proposalId) {
    return this.database.prepare(`
      SELECT * FROM knowledge_proposal_changes
      WHERE proposal_id = ?
      ORDER BY sort_order, id
    `).all(proposalId).map(knowledgeChangeFromRow);
  }

  #replaceKnowledgeChanges(proposalId, changes) {
    this.database.prepare("DELETE FROM knowledge_proposal_changes WHERE proposal_id = ?").run(proposalId);
    const insert = this.database.prepare(`
      INSERT INTO knowledge_proposal_changes (
        id, proposal_id, target_path, operation, base_digest,
        before_content, after_content, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, change] of changes.entries()) {
      insert.run(
        change.id ?? randomUUID(),
        proposalId,
        change.targetPath,
        change.operation,
        change.baseDigest ?? null,
        change.beforeContent ?? null,
        change.afterContent ?? null,
        change.sortOrder ?? index,
      );
    }
  }
}
