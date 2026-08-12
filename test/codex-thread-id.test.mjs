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

test("new task conversations bind only a stable UUID absent from the creation snapshot", () => {
  assert.match(injectionSource, /requestHost\("resolve-task-thread"/);
  assert.match(injectionSource, /marker: request\.marker/);
  assert.match(injectionSource, /startedAt: request\.startedAt/);
  assert.match(injectionSource, /const threadId = normalizeThreadId\(result\?\.threadId\)/);
  assert.match(injectionSource, /result\?\.status === "resolved" && threadId/);
  assert.match(injectionSource, /threadId,/);
  assert.match(injectionSource, /requestId: request\.requestId/);
  assert.match(injectionSource, /commentId: request\.commentId \|\| undefined/);
  assert.match(injectionSource, /THREAD_LINK_RECEIPT_STORAGE_KEY/);
  assert.match(injectionSource, /persistPendingThreadLinkReceipt/);
  assert.match(injectionSource, /deliverPendingThreadLinkReceipt/);
  assert.match(injectionSource, /taskboard:thread-link-ack/);
  assert.match(injectionSource, /THREAD_LINK_RECEIPT_RETRY_MS/);
  assert.doesNotMatch(injectionSource, /taskContextVisible/);
  assert.doesNotMatch(injectionSource, /activePendingThreadId/);
  assert.doesNotMatch(injectionSource, /knownThreadIds/);
  assert.doesNotMatch(injectionSource, /candidateSeenCount/);
  assert.doesNotMatch(
    injectionSource,
    /if \(pendingTaskThreadLink && payload\.threadId\)/,
  );
});

test("opening a linked conversation waits for native content and verifies navigation", () => {
  assert.match(injectionSource, /await waitForNativePaint\(\)/);
  assert.match(injectionSource, /if \(await waitForActiveThread\(normalizedThreadId\)\) return/);
  assert.match(injectionSource, /path: routeForThread\(normalizedThreadId\)/);
  assert.match(injectionSource, /if \(await waitForActiveThread\(normalizedThreadId, 2_000\)\) return/);
  assert.match(injectionSource, /window\.location\.assign\(appUrlForThread\(normalizedThreadId\)\)/);
  assert.match(injectionSource, /await waitForActiveThread\(normalizedThreadId, 3_000\)/);
});
