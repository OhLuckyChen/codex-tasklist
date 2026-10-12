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

const initialKnowledgePages = [
  ["docs/knowledge/index.md", "index", "Project knowledge", "index"],
  ["docs/knowledge/project-overview.md", "project-overview", "Project overview", "overview"],
  ["docs/knowledge/architecture.md", "architecture", "Architecture", "architecture"],
  ["docs/knowledge/code-map.md", "code-map", "Code map", "code-map"],
  ["docs/knowledge/key-flows.md", "key-flows", "Key flows", "flow"],
  ["docs/knowledge/engineering-notes.md", "engineering-notes", "Engineering notes", "engineering"],
  ["docs/knowledge/data-boundaries.md", "data-boundaries", "Data boundaries", "architecture"],
  ["docs/knowledge/interfaces-and-entrypoints.md", "interfaces-and-entrypoints", "Interfaces and entrypoints", "code-map"],
];

function pageContent(id, title, kind) {
  return `---
id: ${id}
title: ${title}
kind: ${kind}
updated_at: 2026-08-10T00:00:00.000Z
sources:
  - type: file
    ref: package.json
---
# ${title}

Evidence-backed project knowledge.
`;
}

function initialAnalysis(overrides = {}) {
  const evidence = [{ type: "file", ref: "src/app.ts" }];
  const changes = [
    ...initialKnowledgePages.map(([targetPath, id, title, kind]) => ({
      targetPath,
      operation: "create",
      afterContent: pageContent(id, title, kind),
    })),
    {
      targetPath: ".taskboard/knowledge-index/manifest.json",
      operation: "create",
      afterContent: JSON.stringify({
        schemaVersion: "1.0.0",
        generatedAt: "2026-08-10T00:00:00.000Z",
        projectSummary: "Demo project",
        scanScope: ["package.json", "src"],
      }),
    },
    {
      targetPath: ".taskboard/knowledge-index/files.json",
      operation: "create",
      afterContent: JSON.stringify([{ path: "src/app.ts", type: "source", language: "typescript", keywords: ["app"] }]),
    },
    {
      targetPath: ".taskboard/knowledge-index/symbols.json",
      operation: "create",
      afterContent: JSON.stringify([{
        path: "src/app.ts",
        name: "createApp",
        kind: "function",
        line: 1,
        importance: "critical",
        evidenceStatus: "confirmed",
        linkedKnowledge: ["docs/knowledge/code-map.md"],
        keywords: ["app"],
      }]),
    },
    {
      targetPath: ".taskboard/knowledge-index/entrypoints.json",
      operation: "create",
      afterContent: JSON.stringify([{
        path: "src/app.ts",
        name: "createApp",
        kind: "function",
        line: 1,
        importance: "critical",
        evidenceStatus: "confirmed",
        businessPurpose: "Start the app",
        runtimePurpose: "Create runtime services",
        successSemantics: "Runtime is ready",
        linkedKnowledge: ["docs/knowledge/interfaces-and-entrypoints.md"],
      }]),
    },
    {
      targetPath: ".taskboard/knowledge-index/objects.json",
      operation: "create",
      afterContent: JSON.stringify(["Project", "Knowledge proposal", "Knowledge index"].map((name) => ({
        name,
        authority: "server/knowledge-service.mjs",
        evidence,
        confidence: "confirmed",
      }))),
    },
    {
      targetPath: ".taskboard/knowledge-index/flows.json",
      operation: "create",
      afterContent: JSON.stringify(["Initialize knowledge", "Review proposal", "Publish knowledge"].map((name) => ({
        name,
        trigger: "User action",
        entrypoint: "createApp",
        components: ["server", "knowledge"],
        stateChanges: ["proposal state changes"],
        successSemantics: "The proposal is ready for review",
        failureSemantics: "The callback records an error",
        evidence,
        confidence: "confirmed",
      }))),
    },
    {
      targetPath: ".taskboard/knowledge-index/docs.json",
      operation: "create",
      afterContent: JSON.stringify([{
        title: "README",
        source: "README.md",
        keywords: ["readme"],
        summary: "Project README",
      }]),
    },
    {
      targetPath: ".taskboard/knowledge-index/recent.json",
      operation: "create",
      afterContent: JSON.stringify([{
        path: "src/app.ts",
        changed_at: "2026-08-10T00:00:00.000Z",
        source: "git",
        status: "recent",
        reason: "Recently changed",
      }]),
    },
  ];
  return {
    title: "Initial project knowledge",
    summary: "Durable project orientation",
    changes,
    ...overrides,
  };
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
  const content = pageContent("design.demo", "Demo", "design");
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

test("knowledge proposals can publish bounded machine-readable pre-index files", async () => {
  const root = await workspace();
  const indexContent = JSON.stringify([
    {
      path: "src/api.ts",
      type: "source",
      language: "typescript",
      keywords: ["api", "route"],
      freshness: "fresh",
    },
  ], null, 2);
  const service = new KnowledgeService({
    analyze: async () => ({
      title: "Pre-index",
      summary: "Create project routing index",
      changes: [{
        targetPath: ".taskboard/knowledge-index/files.json",
        operation: "create",
        afterContent: indexContent,
      }],
    }),
  });

  const proposal = await service.generateProposal(root, {
    sourceType: "issue",
    sourceSnapshot: { issueIdentifier: "DEMO-1" },
  });
  assert.equal(proposal.changes[0].targetPath, ".taskboard/knowledge-index/files.json");

  const published = await service.publish(root, proposal);
  assert.equal(published.changes[0].targetPath, ".taskboard/knowledge-index/files.json");
  assert.equal(
    await readFile(path.join(root, ".taskboard", "knowledge-index", "files.json"), "utf8"),
    indexContent,
  );
});

test("initial scans require the complete knowledge protocol shape", async () => {
  const root = await workspace();
  const service = new KnowledgeService({ analyze: async () => initialAnalysis() });

  const proposal = await service.generateProposal(root, {
    sourceType: "project_scan",
    sourceSnapshot: { issueIdentifier: "DEMO-INIT" },
  });

  assert.equal(proposal.changes.length, 16);
  assert.equal(
    proposal.changes.some((change) => change.targetPath === ".taskboard/knowledge-index/objects.json"),
    true,
  );
});

test("initial scans reject shallow proposals without core pages and indexes", async () => {
  const root = await workspace();
  const service = new KnowledgeService({
    analyze: async () => ({
      title: "Shallow init",
      summary: "Only an overview",
      changes: [{
        targetPath: "docs/knowledge/index.md",
        operation: "create",
        afterContent: pageContent("index", "Project knowledge", "index"),
      }],
    }),
  });

  await assert.rejects(
    service.generateProposal(root, {
      sourceType: "project_scan",
      sourceSnapshot: { issueIdentifier: "DEMO-INIT" },
    }),
    (error) => error.code === "INCOMPLETE_INITIAL_KNOWLEDGE",
  );
});

test("initial scans reject empty ready proposals before the no-change shortcut", async () => {
  const root = await workspace();
  const service = new KnowledgeService({
    analyze: async () => ({
      title: "Empty init",
      summary: "No changes",
      changes: [],
    }),
  });

  await assert.rejects(
    service.generateProposal(root, {
      sourceType: "project_scan",
      sourceSnapshot: { issueIdentifier: "DEMO-INIT" },
    }),
    (error) => error.code === "INCOMPLETE_INITIAL_KNOWLEDGE",
  );
});

test("initial scans reject critical entrypoints without linked knowledge", async () => {
  const root = await workspace();
  const analysis = initialAnalysis();
  const entrypoint = analysis.changes.find((change) => change.targetPath === ".taskboard/knowledge-index/entrypoints.json");
  entrypoint.afterContent = JSON.stringify([{
    path: "src/app.ts",
    name: "createApp",
    kind: "function",
    line: 1,
    importance: "critical",
    evidenceStatus: "confirmed",
    successSemantics: "Runtime is ready",
  }]);
  const service = new KnowledgeService({ analyze: async () => analysis });

  await assert.rejects(
    service.generateProposal(root, {
      sourceType: "project_scan",
      sourceSnapshot: { issueIdentifier: "DEMO-INIT" },
    }),
    (error) => error.code === "INVALID_KNOWLEDGE_CONTRACT",
  );
});

test("initial scans reject api routes without method, route, line, or request fields", async () => {
  const root = await workspace();
  const analysis = initialAnalysis();
  const symbols = analysis.changes.find((change) => change.targetPath === ".taskboard/knowledge-index/symbols.json");
  symbols.afterContent = JSON.stringify([{
    path: "src/api.ts",
    name: "createThing",
    kind: "api_route",
    importance: "critical",
    evidenceStatus: "confirmed",
    linkedKnowledge: ["docs/knowledge/interfaces-and-entrypoints.md"],
    keywords: ["api"],
  }]);
  const service = new KnowledgeService({ analyze: async () => analysis });

  await assert.rejects(
    service.generateProposal(root, {
      sourceType: "project_scan",
      sourceSnapshot: { issueIdentifier: "DEMO-INIT" },
    }),
    (error) => error.code === "INVALID_KNOWLEDGE_CONTRACT",
  );
});

test("publishing project-scan proposals rechecks the complete initial protocol", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "docs", "knowledge", "index.md"), pageContent("index", "Project knowledge", "index"));
  const service = new KnowledgeService({ analyze: async () => ({}) });

  await assert.rejects(
    service.publish(root, {
      sourceType: "project_scan",
      changes: [{
        targetPath: "docs/knowledge/index.md",
        operation: "update",
        baseDigest: knowledgeInternals.sha256(pageContent("index", "Project knowledge", "index")),
        beforeContent: pageContent("index", "Project knowledge", "index"),
        afterContent: pageContent("index", "Project knowledge", "index"),
      }],
    }),
    (error) => error.code === "INCOMPLETE_INITIAL_KNOWLEDGE",
  );
});

test("knowledge pages reject missing sources and machine-local file references", async () => {
  const root = await workspace();
  const sourceService = new KnowledgeService({
    analyze: async () => ({
      title: "Bad source",
      summary: "Create page with a local source",
      changes: [{
        targetPath: "docs/knowledge/designs/demo.md",
        operation: "create",
        afterContent: `---
id: design.demo
title: Demo
kind: design
updated_at: 2026-08-10T00:00:00.000Z
sources:
  - type: file
    ref: /Users/lincya/project/source.ts
---
# Demo
`,
      }],
    }),
  });

  await assert.rejects(
    sourceService.generateProposal(root, {
      sourceType: "issue",
      sourceSnapshot: { issueIdentifier: "DEMO-1" },
    }),
    (error) => error.code === "INVALID_KNOWLEDGE_CONTRACT",
  );

  const bodyService = new KnowledgeService({
    analyze: async () => ({
      title: "Bad body",
      summary: "Create page with a local path in the body",
      changes: [{
        targetPath: "docs/knowledge/designs/body.md",
        operation: "create",
        afterContent: `${pageContent("design.body", "Body", "design")}\n本机路径 /Users/lincya/project/source.ts 不应进入知识正文。\n`,
      }],
    }),
  });

  await assert.rejects(
    bodyService.generateProposal(root, {
      sourceType: "issue",
      sourceSnapshot: { issueIdentifier: "DEMO-1" },
    }),
    (error) => error.code === "INVALID_KNOWLEDGE_CONTRACT",
  );
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
  assert.match(initial, /\.taskboard\/knowledge-index\/\*:json|\.taskboard\/knowledge-index\/\*\.json/);
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
