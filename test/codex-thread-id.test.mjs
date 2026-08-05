import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  isCodexThreadId,
  normalizeCodexThreadId,
} from "../shared/codex-thread-id.mjs";

const injectionSource = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);

test("Codex thread ids normalize to one bare lowercase UUID format", () => {
  assert.equal(
    normalizeCodexThreadId("local:019FD264-9EE8-7A72-81A1-235DB0B8FE4E"),
    "019fd264-9ee8-7a72-81a1-235db0b8fe4e",
  );
  assert.equal(
    normalizeCodexThreadId("urn:uuid:019fd264-9ee8-7a72-81a1-235db0b8fe4e"),
    "019fd264-9ee8-7a72-81a1-235db0b8fe4e",
  );
});

test("temporary and encoded client thread ids are never accepted", () => {
  assert.equal(normalizeCodexThreadId("client-new-thread:43535464-9980-407d-9053-0dc4fc7626a9"), null);
  assert.equal(normalizeCodexThreadId("local:client-new-thread%3A43535464-9980-407d-9053-0dc4fc7626a9"), null);
  assert.equal(isCodexThreadId("thread-123"), false);
});

test("new task conversations never fall back to the previously active thread", () => {
  assert.match(injectionSource, /const activePendingThreadId = normalizeThreadId\(/);
  assert.match(injectionSource, /threadId: activePendingThreadId/);
  assert.match(injectionSource, /activePendingThreadId !== pendingTaskThreadLink\.previousThreadId/);
  assert.doesNotMatch(
    injectionSource,
    /if \(pendingTaskThreadLink && payload\.threadId\)/,
  );
});

test("opening a linked conversation waits for native content and verifies navigation", () => {
  assert.match(injectionSource, /await waitForNativePaint\(\)/);
  assert.match(injectionSource, /if \(await waitForActiveThread\(normalizedThreadId\)\) return/);
  assert.match(injectionSource, /path: routeForThread\(normalizedThreadId\)/);
});
