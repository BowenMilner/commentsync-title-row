import * as youtubei from "./youtubei.js";

async function handleIncrementalComments(videoId, tabId) {
  let nextToken = null;
  let pageCount = 0;
  let collectedComments = [];
  let sentCount = 0;

  try {
    while (pageCount < 10) {
      const { comments, nextToken: fetchedNextToken } = await youtubei.fetchCommentsPage(
        videoId,
        nextToken,
      );

      if (comments.length > 0) {
        const filtered = dedupeComments(collectedComments, comments);
        collectedComments = filtered.all;
        sentCount += filtered.newlyAdded.length;
        await sendMessage(tabId, {
          type: "comments_update",
          video_id: videoId,
          comments: filtered.newlyAdded,
        });
      }

      if (!fetchedNextToken) {
        break;
      }

      nextToken = fetchedNextToken;
      pageCount += 1;
    }
    await sendMessage(tabId, {
      type: "comments_fetch_complete",
      video_id: videoId,
      count: sentCount,
    });
  } catch (error) {
    console.error("CommentSync Title Row failed to fetch comments", error);
    await sendMessage(tabId, {
      type: "comments_fetch_error",
      video_id: videoId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function dedupeComments(existingComments, incomingComments) {
  const newlyAdded = [];
  const all = [...existingComments];

  incomingComments.forEach((incomingComment) => {
    if (!all.some((comment) => comment.id === incomingComment.id)) {
      all.push(incomingComment);
      newlyAdded.push(incomingComment);
    }
  });

  return { all, newlyAdded };
}

async function sendNewOverlayStatus(status) {
  const tabs = (await browser.tabs.query({})).filter((tab) =>
    tab.url.startsWith("https://www.youtube.com/watch?v="),
  );

  if (!tabs) {
    return;
  }

  const message = { type: "isActive", status };
  tabs.forEach(async (tab) => await sendMessage(tab.id, message));
}

async function sendMessage(tabId, message) {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.error("CommentSync Title Row failed to send a tab message", error);
  }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "comments") {
    handleIncrementalComments(message.video_id, sender.tab.id)
      .then(() => sendResponse(true))
      .catch((error) => {
        console.error("CommentSync Title Row failed to handle comments request", error);
        sendResponse(false);
      });
    return true;
  }

  if (message.type === "isActive") {
    sendNewOverlayStatus(message.status)
      .then(() => sendResponse(true))
      .catch((error) => {
        console.error("CommentSync Title Row failed to handle active-status request", error);
        sendResponse(false);
      });
    return true;
  }

  return false;
});
