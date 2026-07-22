import assert from "node:assert/strict";
import test from "node:test";

test("acknowledges accepted background work synchronously", async () => {
  let runtimeListener = null;
  let tabRemovedListener = null;
  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;

  globalThis.browser = {
    runtime: {
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    tabs: {
      onRemoved: { addListener(listener) { tabRemovedListener = listener; } },
      async sendMessage() { return true; },
    },
  };
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          contents: {
            twoColumnWatchNextResults: { results: { results: { contents: [] } } },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    await import(`../background/background.js?test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");
    assert.equal(typeof tabRemovedListener, "function");

    let response;
    const returnValue = runtimeListener(
      { type: "comments", video_id: "video-id" },
      { tab: { id: 42 } },
      (value) => { response = value; },
    );
    assert.equal(returnValue, false);
    assert.equal(response, true);
  } finally {
    globalThis.browser = originalBrowser;
    globalThis.fetch = originalFetch;
  }
});
