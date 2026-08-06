import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveCodexSessionByMarker } from "../scripts/codex-session-resolver.mjs";

async function writeSession(root, name, threadId, messages) {
  const directory = path.join(root, "2026", "08", "06");
  await mkdir(directory, { recursive: true });
  const records = [
    { type: "session_meta", payload: { session_id: threadId } },
    ...messages.map((text) => ({ type: "response_item", payload: { role: "user", text } })),
  ];
  await writeFile(
    path.join(directory, `${name}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

test("resolves the Codex UUID from the unique taskboard request marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "taskboard-session-resolver-"));
  const expected = "019fd55d-010a-76d1-90ec-dcde7169b1c3";
  await writeSession(root, "matching", expected, ["work item\n[taskboard-request:req-12345678]"]);
  await writeSession(root, "other", "019fd55b-45e8-7fe3-afb8-d5bc5f266cd4", ["another request"]);

  assert.equal(await resolveCodexSessionByMarker({
    sessionsRoot: root,
    marker: "[taskboard-request:req-12345678]",
    startedAt: Date.now() - 1_000,
  }), expected);
});

test("returns null until a session containing the request marker exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "taskboard-session-resolver-"));
  await writeSession(root, "other", "019fd55b-45e8-7fe3-afb8-d5bc5f266cd4", ["another request"]);
  assert.equal(await resolveCodexSessionByMarker({
    sessionsRoot: root,
    marker: "[taskboard-request:req-87654321]",
    startedAt: Date.now() - 1_000,
  }), null);
});

test("refuses to choose when one marker appears in multiple sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "taskboard-session-resolver-"));
  const marker = "[taskboard-request:req-duplicate]";
  await writeSession(root, "first", "019fd55d-010a-76d1-90ec-dcde7169b1c3", [marker]);
  await writeSession(root, "second", "019fd55b-45e8-7fe3-afb8-d5bc5f266cd4", [marker]);
  await assert.rejects(
    resolveCodexSessionByMarker({ sessionsRoot: root, marker, startedAt: Date.now() - 1_000 }),
    /Multiple Codex sessions/,
  );
});
