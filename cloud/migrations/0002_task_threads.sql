CREATE TABLE task_threads (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, thread_id TEXT NOT NULL, linked_at TEXT NOT NULL, PRIMARY KEY (task_id, thread_id));
CREATE INDEX task_threads_task_linked ON task_threads(task_id, linked_at DESC, thread_id);
INSERT OR IGNORE INTO task_threads (task_id, thread_id, linked_at) SELECT id, thread_id, updated_at FROM tasks WHERE thread_id IS NOT NULL;
INSERT OR IGNORE INTO task_threads (task_id, thread_id, linked_at) SELECT task_id, thread_id, updated_at FROM comments WHERE thread_id IS NOT NULL;
