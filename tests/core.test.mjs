import assert from "node:assert/strict";
import test from "node:test";

await import("../shared/core.js");
const core = globalThis.CommentSyncCore;

test("parses short, long, and hour timestamps", () => {
  assert.deepEqual(
    core.findTimestampContexts("0:00, 123:45, and 1:02:03").map(({ value, time }) => ({ value, time })),
    [
      { value: "0:00", time: 0 },
      { value: "123:45", time: 7425 },
      { value: "1:02:03", time: 3723 },
    ],
  );
});

test("preserves line labels when segmenting timestamp lists", () => {
  const text = "Intro 0:00 sounds great\nSecond section 1:00 gets louder";
  const timestamps = core.findTimestampContexts(text);
  assert.equal(core.getTimestampSegment(text, timestamps, 0), "Intro 0:00 sounds great");
  assert.equal(core.getTimestampSegment(text, timestamps, 1), "Second section 1:00 gets louder");
});

test("detects chapter lists that start near the beginning", () => {
  const text = "0:15 Intro\n1:20 Topic\n2:45 Outro";
  assert.equal(core.isChaptersComment(text, core.findTimestampContexts(text)), true);
  const conversation = "At 0:15 I laughed, then 1:20 surprised me, and 2:45 was great";
  assert.equal(core.isChaptersComment(conversation, core.findTimestampContexts(conversation)), false);
});

test("parses localized and abbreviated vote counts", () => {
  assert.equal(core.parseVoteCount("1,234"), 1234);
  assert.equal(core.parseVoteCount("1.2K"), 1200);
  assert.equal(core.parseVoteCount("1,2K"), 1200);
  assert.equal(core.parseVoteCount("1.2万"), 12000);
  assert.equal(core.parseVoteCount("2億"), 200_000_000);
});

test("merges comment and continuation arrays from all response endpoints", () => {
  const thread = { commentThreadRenderer: { id: "thread" } };
  const continuation = { continuationItemRenderer: { id: "next" } };
  const response = {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: [thread] } },
      { reloadContinuationItemsCommand: { continuationItems: [continuation] } },
    ],
  };
  assert.deepEqual(core.getContinuationItems(response), [thread, continuation]);
});

test("fallback IDs distinguish identical text from different authors", () => {
  assert.notEqual(
    core.fallbackCommentId("same comment 1:00", "Alice"),
    core.fallbackCommentId("same comment 1:00", "Bob"),
  );
});

test("groups chained nearby comments and keeps the most-liked entries", () => {
  const selected = core.selectQueueComments(
    [
      { id: "a", time: 0, likes: 1 },
      { id: "b", time: 3, likes: 8 },
      { id: "c", time: 6, likes: 4 },
      { id: "d", time: 7, likes: 6 },
    ],
    3,
    3,
  );
  assert.deepEqual(selected.map((comment) => comment.id), ["b", "d", "c"]);
  assert.ok(selected.every((comment) => comment.groupSize === 3));
});

test("retries transient HTTP errors and rejects permanent errors", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("temporary", { status: 500, headers: { "content-type": "text/plain" } })
      : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    assert.deepEqual(await core.fetchJson("https://example.test", {}, { retries: 1 }), { ok: true });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
