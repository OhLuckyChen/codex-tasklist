#!/usr/bin/env node

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeCodexThreadId } from "../shared/codex-thread-id.mjs";

function parseArgs(argv) {
  const options = {
    apply: false,
    database: path.resolve(".data/taskboard.sqlite"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--database") options.database = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const database = new DatabaseSync(options.database);
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const comments = database.prepare(`
  SELECT id, task_id, thread_id FROM comments WHERE thread_id IS NOT NULL
`).all();
const validCommentThreadsByTask = new Map();
const commentChanges = [];
for (const comment of comments) {
  const normalized = normalizeCodexThreadId(comment.thread_id);
  if (normalized) {
    let ids = validCommentThreadsByTask.get(comment.task_id);
    if (!ids) {
      ids = new Set();
      validCommentThreadsByTask.set(comment.task_id, ids);
    }
    ids.add(normalized);
  }
  if (normalized !== comment.thread_id) {
    commentChanges.push({ id: comment.id, from: comment.thread_id, to: normalized });
  }
}

const tasks = database.prepare(`
  SELECT id, identifier, thread_id FROM tasks WHERE thread_id IS NOT NULL
`).all();
const taskChanges = [];
for (const task of tasks) {
  let normalized = normalizeCodexThreadId(task.thread_id);
  if (!normalized) {
    const candidates = validCommentThreadsByTask.get(task.id) ?? new Set();
    normalized = candidates.size === 1 ? [...candidates][0] : null;
  }
  if (normalized !== task.thread_id) {
    taskChanges.push({
      id: task.id,
      identifier: task.identifier,
      from: task.thread_id,
      to: normalized,
    });
  }
}

const hasTaskThreads = database.prepare(`
  SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
`).get();
const taskThreadChanges = hasTaskThreads
  ? database.prepare("SELECT task_id, thread_id FROM task_threads").all()
    .flatMap((entry) => {
      const normalized = normalizeCodexThreadId(entry.thread_id);
      return normalized === entry.thread_id
        ? []
        : [{ taskId: entry.task_id, from: entry.thread_id, to: normalized }];
    })
  : [];

if (options.apply) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const updateComment = database.prepare("UPDATE comments SET thread_id = ? WHERE id = ?");
    for (const change of commentChanges) updateComment.run(change.to, change.id);
    const updateTask = database.prepare("UPDATE tasks SET thread_id = ? WHERE id = ?");
    for (const change of taskChanges) updateTask.run(change.to, change.id);
    if (hasTaskThreads) {
      const deleteTaskThread = database.prepare(`
        DELETE FROM task_threads WHERE task_id = ? AND thread_id = ?
      `);
      const insertTaskThread = database.prepare(`
        INSERT INTO task_threads (task_id, thread_id, linked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(task_id, thread_id) DO NOTHING
      `);
      for (const change of taskThreadChanges) {
        deleteTaskThread.run(change.taskId, change.from);
        if (change.to) insertTaskThread.run(change.taskId, change.to, new Date().toISOString());
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

database.close();
console.log(JSON.stringify({
  database: options.database,
  applied: options.apply,
  taskChanges,
  commentChanges,
  taskThreadChanges,
}, null, 2));
