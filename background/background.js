import "../shared/core.js";

const extensionApi = globalThis.browser || globalThis.chrome;
const usingBrowserPromiseApi = Boolean(globalThis.browser);
const core = globalThis.CommentSyncCore;
const activeFetchesByTab = new Map();

function fetchKeyForTab(tabId) {
  return String(tabId);
}

function cancelFetch(tabId) {
  const key = fetchKeyForTab(tabId);
  activeFetchesByTab.get(key)?.abortController.abort();
  activeFetchesByTab.delete(key);
}

function startIncrementalComments(videoId, tabId) {
  const fetchKey = fetchKeyForTab(tabId);
  const existingFetch = activeFetchesByTab.get(fetchKey);
  if (existingFetch?.videoId === videoId) {
    return true;
  }

  existingFetch?.abortController.abort();
  const abortController = new AbortController();
  activeFetchesByTab.set(fetchKey, { videoId, abortController });

  handleIncrementalComments(videoId, tabId, abortController)
    .catch((error) => {
      if (!abortController.signal.aborted && error?.name !== "AbortError") {
        console.error("CommentSync Title Row failed to handle comments request", error);
      }
    })
    .finally(() => {
      if (activeFetchesByTab.get(fetchKey)?.abortController === abortController) {
        activeFetchesByTab.delete(fetchKey);
      }
    });

  return true;
}

async function handleIncrementalComments(videoId, tabId, abortController) {
  let nextToken = null;
  let pageCount = 0;
  let sentCount = 0;
  const seenCommentIds = new Set();

  try {
    while (pageCount < 10 && !abortController.signal.aborted) {
      const stats = { threads: 0, timestamped: 0, chapterSkipped: 0, missingMetadata: 0 };
      const { comments, nextToken: fetchedNextToken } = await core.fetchCommentsPage(
        videoId,
        nextToken,
        abortController.signal,
        stats,
      );

      const newlyAdded = comments.filter((comment) => {
        if (seenCommentIds.has(comment.id)) {
          return false;
        }
        seenCommentIds.add(comment.id);
        return true;
      });

      if (stats.timestamped > 0 || newlyAdded.length > 0) {
        console.info(
          `CommentSync Title Row fetched page: ${newlyAdded.length} accepted from ${stats.timestamped} timestamp(s), ${stats.chapterSkipped} chapter list(s), ${stats.missingMetadata} missing metadata, ${stats.threads} thread(s) scanned`,
        );
      }

      if (newlyAdded.length > 0) {
        const delivered = await sendMessage(tabId, {
          type: "comments_update",
          video_id: videoId,
          comments: newlyAdded,
        });
        if (!delivered) {
          cancelFetch(tabId);
          return;
        }
        sentCount += newlyAdded.length;
      }

      if (!fetchedNextToken) {
        break;
      }

      nextToken = fetchedNextToken;
      pageCount += 1;
    }

    if (!abortController.signal.aborted) {
      await sendMessage(tabId, {
        type: "comments_fetch_complete",
        video_id: videoId,
        count: sentCount,
      });
    }
  } catch (error) {
    if (abortController.signal.aborted || error?.name === "AbortError") {
      return;
    }

    console.error("CommentSync Title Row failed to fetch comments", error);
    await sendMessage(tabId, {
      type: "comments_fetch_error",
      video_id: videoId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendMessage(tabId, message) {
  try {
    await sendTabMessage(tabId, message);
    return true;
  } catch (error) {
    console.error("CommentSync Title Row failed to send a tab message", error);
    return false;
  }
}

function sendTabMessage(tabId, message) {
  if (usingBrowserPromiseApi) {
    return extensionApi.tabs.sendMessage(tabId, message);
  }

  return new Promise((resolve, reject) => {
    extensionApi.tabs.sendMessage(tabId, message, (response) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message.type === "comments") {
    const accepted =
      Boolean(tabId && message.video_id) && startIncrementalComments(message.video_id, tabId);
    sendResponse(accepted);
    return false;
  }

  if (message.type === "cancel_comments") {
    if (tabId) {
      cancelFetch(tabId);
    }
    sendResponse(true);
    return false;
  }

  return false;
});

extensionApi.tabs.onRemoved.addListener((tabId) => cancelFetch(tabId));
