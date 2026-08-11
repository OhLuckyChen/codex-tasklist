import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { KnowledgeService, knowledgeInternals } from "../server/knowledge-service.mjs";

const directories = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop(), { recursive: true, force: true });
});

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-knowledge-"));
  directories.push(directory);
  await mkdir(path.join(directory, "docs", "knowledge"), { recursive: true });
  return directory;
}

function gitBlob(value) {
  return `git-blob:${createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0${value}`).digest("hex")}`;
}

test("knowledge pages expose readable bodies and deterministic source health", async () => {
  const root = await workspace();
  const source = "export const answer = 42;\n";
  await writeFile(path.join(root, "source.ts"), source);
  await writeFile(path.join(root, "docs", "knowledge", "index.md"), `---
id: index
title: 项目知识
kind: index
updated_at: 2026-08-10
sources:
  - type: file
    ref: source.ts
    revision: ${gitBlob(source)}
---
# 项目知识

正文内容。
`);
  const service = new KnowledgeService({ analyze: async () => ({}) });

  const overview = await service.overview(root);
  assert.equal(overview.initialized, true);
  assert.equal(overview.indexPath, "docs/knowledge/index.md");
  assert.equal(overview.pages[0].health, "fresh");

  const page = await service.readPage(root, "docs/knowledge/index.md");
  assert.equal(page.content.startsWith("# 项目知识"), true);
  assert.equal(page.content.includes("updated_at"), false);

  await writeFile(path.join(root, "source.ts"), "export const answer = 43;\n");
  assert.equal((await service.overview(root)).pages[0].health, "stale");
});

test("sha256 sources keep their declared revision algorithm", async () => {
  const root = await workspace();
  const source = "workspace-level document\n";
  const revision = knowledgeInternals.sha256(source);
  await writeFile(path.join(root, "source.md"), source);
  await writeFile(path.join(root, "docs", "knowledge", "index.md"), `---
id: index
title: Project knowledge
kind: index
updated_at: 2026-08-11
sources:
  - type: file
    ref: source.md
    revision: ${revision}
---
# Project knowledge
`);

  const service = new KnowledgeService({ analyze: async () => ({}) });
  const overview = await service.overview(root);
  assert.equal(overview.pages[0].sources[0].actualRevision, revision);
  assert.equal(overview.pages[0].sources[0].status, "fresh");
});

test("temporarily inaccessible sources degrade health instead of breaking the overview", async () => {
  const root = await workspace();
  const sourcePath = path.join(root, "protected.ts");
  await writeFile(sourcePath, "export const protectedValue = true;\n");
  await writeFile(path.join(root, "docs", "knowledge", "index.md"), `---
id: index
title: Project knowledge
kind: index
updated_at: 2026-08-11
sources:
  - type: file
    ref: protected.ts
    revision: git-blob:unavailable
---
# Project knowledge
`);
  await chmod(sourcePath, 0o000);

  try {
    const service = new KnowledgeService({ analyze: async () => ({}) });
    const overview = await service.overview(root);
    assert.equal(overview.pages[0].sources[0].actualRevision, null);
    assert.equal(overview.pages[0].sources[0].status, "unverified");
    assert.equal(overview.pages[0].health, "unverified");
  } finally {
    await chmod(sourcePath, 0o600);
  }
});

test("generated proposals remain pending data until an idempotent safe publish", async () => {
  const root = await workspace();
  const content = "---\nid: design.demo\ntitle: Demo\nkind: design\n---\n# Demo\n";
  const service = new KnowledgeService({
    analyze: async () => ({
      title: "Demo design",
      summary: "Create the confirmed design page",
      changes: [{
        targetPath: "docs/knowledge/designs/demo.md",
        operation: "create",
        afterContent: content,
      }],
    }),
  });

  const proposal = await service.generateProposal(root, {
    sourceType: "issue",
    sourceSnapshot: { issue: { identifier: "DEMO-1", version: 2 } },
  });
  assert.equal(proposal.changes[0].baseDigest, null);
  await assert.rejects(readFile(path.join(root, "docs", "knowledge", "designs", "demo.md")));

  const first = await service.publish(root, proposal);
  assert.equal(first.changes[0].digest, knowledgeInternals.sha256(content));
  assert.equal(await readFile(path.join(root, "docs", "knowledge", "designs", "demo.md"), "utf8"), content);

  const retried = await service.publish(root, proposal);
  assert.deepEqual(retried.changes, first.changes);
});

test("publish rejects traversal and detects real concurrent edits", async () => {
  const root = await workspace();
  const target = path.join(root, "docs", "knowledge", "architecture.md");
  await writeFile(target, "before\n");
  const service = new KnowledgeService({ analyze: async () => ({}) });

  await assert.rejects(
    service.publish(root, {
      changes: [{
        targetPath: "../outside.md",
        operation: "create",
        baseDigest: null,
        beforeContent: null,
        afterContent: "outside",
      }],
    }),
    (error) => error.code === "INVALID_KNOWLEDGE_PATH",
  );

  const proposal = {
    changes: [{
      targetPath: "docs/knowledge/architecture.md",
      operation: "update",
      baseDigest: knowledgeInternals.sha256("before\n"),
      beforeContent: "before\n",
      afterContent: "after\n",
    }],
  };
  await writeFile(target, "concurrent\n");
  await assert.rejects(
    service.publish(root, proposal),
    (error) => error.code === "KNOWLEDGE_PUBLISH_CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), "concurrent\n");
});

test("project knowledge runs distinguish initial scans from deterministic incremental refreshes", () => {
  const service = new KnowledgeService({ analyze: async () => ({}) });
  const initial = service.knowledgeRunInstruction({
    sourceType: "project_scan",
    sourceSnapshot: { requestedAt: "2026-08-10" },
    callbackUrl: "http://127.0.0.1:47823/callback",
    callbackToken: "local-token",
  });
  assert.match(initial, /complete project understanding/);
  assert.match(initial, /git-blob:<git hash-object value>/);
  assert.match(initial, /do not edit, create, delete or format project files/);

  const incremental = service.knowledgeRunInstruction({
    sourceType: "stale_refresh",
    sourceSnapshot: {
      pages: ["docs/knowledge/architecture.md"],
      sources: [{ type: "file", ref: "src/app.ts", revision: "git-blob:old" }],
    },
    callbackUrl: "http://127.0.0.1:47823/callback",
    callbackToken: "local-token",
  });
  assert.match(incremental, /changed or stale sources and affected knowledge pages/);
  assert.match(incremental, /leave unrelated knowledge unchanged/);
});
