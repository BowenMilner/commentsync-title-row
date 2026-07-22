let overlayElement = null;
let slotElement = null;
let videoContainer = null;
let monitoringInitialized = false;
let isDisplaying = false;
let isActive = true;
let comments = [];
let commentsQueue = [];
let revealFrame = null;
let monitoredVideo = null;
let previousVideoTime = 0;
let activeVideoId = null;
let navigationTimer = null;
let runId = 0;
let fallbackFetchVideoId = null;
let fallbackAbortController = null;
let monitorRetryTimer = null;
let queueRetryTimer = null;
let scanRetryTimer = null;
let locationPollTimer = null;
let lastKnownUrl = location.href;

const extensionApi = globalThis.browser || globalThis.chrome;
const usingBrowserPromiseApi = Boolean(globalThis.browser);
const core = globalThis.CommentSyncCore;
const SLOT_ID = "commentsync-title-row-slot";
const OVERLAY_ID = "commentsync-title-row-comment";
const COMMENT_TRIGGER_WINDOW_SECONDS = 6;
const COMMENT_GROUP_WINDOW_SECONDS = 3;
const MAX_COMMENTS_PER_GROUP = 3;
const MAX_QUEUE_LATENESS_SECONDS = 8;
const MAX_GROUP_DISPLAY_MS = 9000;
const BETWEEN_COMMENT_DELAY_MS = 500;
const DOM_SCAN_RETRY_COUNT = 6;
const DOM_SCAN_RETRY_DELAY_MS = 1500;

function watchLocation(callback) {
  clearInterval(locationPollTimer);
  locationPollTimer = setInterval(() => {
    if (lastKnownUrl !== location.href) {
      lastKnownUrl = location.href;
      callback();
    }
  }, 1000);
}

async function main() {
  const currentRunId = ++runId;
  resetVariables();
  isActive = await isActiveFunc();

  if (currentRunId !== runId) {
    return;
  }

  if (!isActive) {
    activeVideoId = null;
    removeInterface();
    sendRuntimeMessage({ type: "cancel_comments" }).catch(() => {});
    return;
  }

  const videoId = getVideoId();
  if (!videoId) {
    activeVideoId = null;
    removeInterface();
    sendRuntimeMessage({ type: "cancel_comments" }).catch(() => {});
    return;
  }

  activeVideoId = videoId;

  createInterface();
  requestBackgroundComments(videoId, currentRunId);
  scheduleCommentScan(currentRunId);
}

async function requestBackgroundComments(videoId, currentRunId) {
  try {
    const accepted = await sendRuntimeMessage({ type: "comments", video_id: videoId });

    if (!accepted && currentRunId === runId) {
      runFallbackFetch(videoId, currentRunId);
    }
  } catch (error) {
    if (currentRunId === runId) {
      console.error("CommentSync Title Row failed to request background comments", error);
      runFallbackFetch(videoId, currentRunId);
    }
  }
}

function runFallbackFetch(videoId, currentRunId) {
  if (!videoId || currentRunId !== runId || fallbackFetchVideoId === videoId) {
    return;
  }

  fallbackAbortController?.abort();
  fallbackAbortController = new AbortController();
  fallbackFetchVideoId = videoId;

  fetchIncrementalComments(videoId, currentRunId, fallbackAbortController.signal).catch((error) => {
    if (currentRunId === runId && error?.name !== "AbortError") {
      console.error("CommentSync Title Row failed to fetch fallback comments in-page", error);
    }
  });
}

function getVideoId() {
  return new URL(location.href).searchParams.get("v");
}

function scheduleMain() {
  clearTimeout(navigationTimer);
  navigationTimer = setTimeout(() => {
    const videoId = getVideoId();

    if (videoId === activeVideoId && monitoringInitialized) {
      ensureSlot();
      return;
    }

    main();
  }, 350);
}

function createInterface() {
  if (document.getElementById(OVERLAY_ID)) {
    ensureSlot();
    return;
  }

  overlayElement = document.createElement("div");
  overlayElement.id = OVERLAY_ID;
  overlayElement.setAttribute("aria-live", "polite");

  const avatar = document.createElement("img");
  avatar.classList.add("commentsync-avatar");
  avatar.alt = "";

  const content = document.createElement("div");
  content.classList.add("commentsync-content");

  const text = document.createElement("span");
  text.classList.add("commentsync-text");

  content.appendChild(text);
  overlayElement.append(avatar, content);
  ensureSlot();
}

function ensureSlot() {
  if (
    slotElement?.isConnected &&
    overlayElement?.isConnected &&
    overlayElement.parentElement === slotElement
  ) {
    return;
  }

  const topRow = document.querySelector("ytd-watch-metadata #top-row");
  const actions = document.querySelector("ytd-watch-metadata #actions");
  const fallback = document.querySelector("ytd-watch-metadata #above-the-fold");
  const parent = topRow || fallback;

  if (!parent || !overlayElement) {
    return;
  }

  if (!slotElement || !slotElement.isConnected) {
    slotElement = document.getElementById(SLOT_ID) || document.createElement("div");
    slotElement.id = SLOT_ID;
  }

  if (topRow && actions && actions.parentElement === topRow) {
    topRow.insertBefore(slotElement, actions);
  } else if (!slotElement.isConnected) {
    parent.appendChild(slotElement);
  }

  if (overlayElement.parentElement !== slotElement) {
    slotElement.appendChild(overlayElement);
  }
}

function removeInterface() {
  const existingSlot = document.getElementById(SLOT_ID);
  if (existingSlot) {
    existingSlot.remove();
  }

  overlayElement = null;
  slotElement = null;
}

function startMonitoring(currentRunId = runId) {
  if (currentRunId !== runId) {
    return;
  }

  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  videoContainer = document.querySelector("#container .html5-video-player");
  if (!video) {
    clearTimeout(monitorRetryTimer);
    monitorRetryTimer = setTimeout(() => startMonitoring(currentRunId), 500);
    return;
  }

  if (monitoredVideo === video) {
    monitoringInitialized = true;
    queueCurrentComments(video.currentTime);
    return;
  }

  monitoredVideo?.removeEventListener("timeupdate", handleTimeUpdate);
  monitoredVideo?.removeEventListener("seeking", handleSeeking);

  monitoredVideo = video;
  previousVideoTime = video.currentTime;
  monitoringInitialized = true;
  video.addEventListener("timeupdate", handleTimeUpdate);
  video.addEventListener("seeking", handleSeeking);
  queueCurrentComments(video.currentTime);
  console.info("CommentSync Title Row playback monitor attached");
}

function handleTimeUpdate() {
  ensureSlot();
  previousVideoTime = monitoredVideo.currentTime;
  queueCurrentComments(previousVideoTime);
}

function handleSeeking() {
  if (Math.abs(monitoredVideo.currentTime - previousVideoTime) > 6) {
    hideOverlay();
    comments.forEach((comment) => {
      comment.processed = false;
    });
    commentsQueue = [];
  }
}

function queueCurrentComments(currentTime) {
  if (isAdPlaying()) {
    return;
  }

  const matchingComments = comments.filter((comment) => {
    if (
      currentTime < comment.time ||
      currentTime >= comment.time + COMMENT_TRIGGER_WINDOW_SECONDS ||
      comment.processed
    ) {
      return false;
    }

    comment.processed = true;
    return true;
  });

  if (matchingComments.length > 0) {
    const selectedComments = selectQueueComments(matchingComments);
    console.info(
      `CommentSync Title Row queued ${selectedComments.length}/${matchingComments.length} comment(s) at ${Math.floor(currentTime)}s`,
    );
    commentsQueue.push(...selectedComments);
    processQueue(runId);
  }
}

async function processQueue(currentRunId = runId) {
  if (currentRunId !== runId || isDisplaying || commentsQueue.length === 0 || !isActive) {
    return;
  }

  if (isAdPlaying()) {
    scheduleQueueRetry(currentRunId);
    return;
  }

  const currentTime = monitoredVideo?.currentTime || 0;
  const nextComment = getNextFreshQueuedComment(currentTime);
  if (!nextComment) {
    return;
  }

  isDisplaying = true;
  if (!showOverlay(nextComment)) {
    isDisplaying = false;
    await delay(50);
    processQueue(currentRunId);
    return;
  }
  await delay(getDisplayDuration(nextComment));
  if (currentRunId !== runId) {
    return;
  }
  hideOverlay();
  isDisplaying = false;
  await delay(BETWEEN_COMMENT_DELAY_MS);
  processQueue(currentRunId);
}

function scheduleQueueRetry(currentRunId) {
  clearTimeout(queueRetryTimer);
  queueRetryTimer = setTimeout(() => {
    if (currentRunId === runId) {
      processQueue(currentRunId);
    }
  }, 2000);
}

function selectQueueComments(matchingComments) {
  return core.selectQueueComments(
    matchingComments,
    COMMENT_GROUP_WINDOW_SECONDS,
    MAX_COMMENTS_PER_GROUP,
  );
}

function getNextFreshQueuedComment(currentTime) {
  while (commentsQueue.length > 0) {
    const comment = commentsQueue.shift();

    if (currentTime <= comment.time + MAX_QUEUE_LATENESS_SECONDS) {
      return comment;
    }

    console.info(
      `CommentSync Title Row dropped stale comment at ${comment.time}s; current time is ${Math.floor(currentTime)}s`,
    );
  }

  return null;
}

function getDisplayDuration(comment) {
  const textLength = (comment.displayText || comment.text || "").length;
  const baseDuration = Math.max(3000, Math.min(5500, 2500 + textLength * 25));

  if (!comment.groupSize || comment.groupSize <= 1) {
    return baseDuration;
  }

  return Math.min(baseDuration, Math.floor(MAX_GROUP_DISPLAY_MS / comment.groupSize));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAdPlaying() {
  if (!videoContainer) {
    return false;
  }

  const adIsPlaying =
    videoContainer.classList.contains("ad-showing") ||
    videoContainer.classList.contains("ad-interrupting");

  if (adIsPlaying) {
    hideOverlay();
  }

  return adIsPlaying;
}

function scheduleCommentScan(currentRunId, attempt = 0) {
  clearTimeout(scanRetryTimer);
  scanRetryTimer = setTimeout(() => {
    if (currentRunId !== runId) {
      return;
    }

    const acceptedCount = scanComments(currentRunId);
    if (acceptedCount === 0 && attempt < DOM_SCAN_RETRY_COUNT) {
      scheduleCommentScan(currentRunId, attempt + 1);
    }
  }, attempt === 0 ? 5000 : DOM_SCAN_RETRY_DELAY_MS);
}

function scanComments(currentRunId = runId) {
  if (currentRunId !== runId) {
    return 0;
  }

  const threads = document.querySelectorAll("ytd-comment-thread-renderer");

  if (threads.length === 0) {
    return 0;
  }

  const scannedComments = [];
  const scanStats = {
    threads: threads.length,
    timestamped: 0,
    chapterSkipped: 0,
    missingMetadata: 0,
    accepted: 0,
  };

  for (const thread of threads) {
    const commentText = thread.querySelector("#content-text");
    if (!commentText) {
      continue;
    }

    const rawText = commentText.innerText;
    const timestamps = core.findTimestampContexts(rawText);
    if (timestamps.length === 0) {
      continue;
    }

    scanStats.timestamped += timestamps.length;

    if (core.isChaptersComment(rawText, timestamps)) {
      scanStats.chapterSkipped += 1;
      continue;
    }

    const author = thread.querySelector("#author-text span");
    const avatar = thread.querySelector("#author-thumbnail #img");
    const name = author?.innerText.trim() || "YouTube commenter";
    const avatarUrl = avatar?.src || "";
    const sourceId =
      thread.getAttribute("id") || core.fallbackCommentId(rawText, `${name}\u0000${avatarUrl}`);
    const voteCount =
      thread.querySelector("#vote-count-middle")?.textContent ||
      thread.querySelector("#vote-count-left")?.textContent ||
      "";

    if (!author || !avatarUrl) {
      scanStats.missingMetadata += 1;
    }

    timestamps.forEach((timestamp, index) => {
      const id = `${sourceId}-${timestamp.time}-${index}`;

      if (
        timestamp.time !== null &&
        !comments.some((comment) => comment.id === id) &&
        !scannedComments.some((comment) => comment.id === id)
      ) {
        scannedComments.push({
          id,
          time: timestamp.time,
          timestamp: timestamp.value,
          displayText: core.getTimestampSegment(rawText, timestamps, index),
          text: rawText,
          name,
          avatar: avatarUrl,
          likes: core.parseVoteCount(voteCount),
          processed: false,
        });
        scanStats.accepted += 1;
      }
    });
  }

  if (scanStats.timestamped > 0 || scanStats.accepted > 0) {
    console.info(
      `CommentSync Title Row DOM scan: ${scanStats.accepted} accepted from ${scanStats.timestamped} timestamp(s), ${scanStats.chapterSkipped} chapter list(s), ${scanStats.missingMetadata} missing metadata, ${scanStats.threads} thread(s) scanned`,
    );
  }

  return addComments(scannedComments, currentRunId);
}

async function fetchIncrementalComments(videoId, currentRunId, signal) {
  let nextToken = null;
  let pageCount = 0;

  while (pageCount < 10 && currentRunId === runId && !signal?.aborted) {
    const { comments: fetchedComments, nextToken: fetchedNextToken } = await core.fetchCommentsPage(
      videoId,
      nextToken,
      signal,
    );

    if (currentRunId !== runId || signal?.aborted) {
      return;
    }

    addComments(fetchedComments, currentRunId);

    if (!fetchedNextToken) {
      break;
    }

    nextToken = fetchedNextToken;
    pageCount += 1;
  }
}

function addComments(incomingComments, currentRunId = runId) {
  if (currentRunId !== runId) {
    return 0;
  }

  if (!Array.isArray(incomingComments) || incomingComments.length === 0) {
    return 0;
  }

  const previousCount = comments.length;
  let incompleteMetadataCount = 0;

  incomingComments.forEach((incomingComment) => {
    if (!comments.some((comment) => comment.id === incomingComment.id)) {
      comments.push(incomingComment);

      if (incomingComment.metadataIncomplete) {
        incompleteMetadataCount += 1;
      }
    }
  });

  comments.sort((a, b) => a.time - b.time);
  console.info(
    `CommentSync Title Row accepted ${comments.length - previousCount} new comment(s); ${comments.length} total; ${incompleteMetadataCount} with fallback metadata`,
  );

  if (!monitoringInitialized) {
    startMonitoring(currentRunId);
  }

  return comments.length - previousCount;
}

function showOverlay(comment) {
  try {
    if (!overlayElement || !comment) {
      return false;
    }

    ensureSlot();

    if (revealFrame) {
      cancelAnimationFrame(revealFrame);
    }

    overlayElement.classList.remove("commentsync-visible");
    overlayElement.classList.add("commentsync-hiding");
    overlayElement.children[0].src = comment.avatar || "";
    overlayElement.children[0].style.display = comment.avatar ? "" : "none";

    const timestamp =
      comment.timestamp || core.findTimestampContexts(comment.text || "")[0]?.value;
    if (!timestamp) {
      console.warn("CommentSync Title Row skipped a comment without a timestamp", comment);
      return false;
    }

    renderCommentText(
      overlayElement.children[1].children[0],
      comment.displayText || comment.text || timestamp,
      timestamp,
    );
    overlayElement.getBoundingClientRect();

    revealFrame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => {
        overlayElement.classList.remove("commentsync-hiding");
        overlayElement.classList.add("commentsync-visible");
        revealFrame = null;
      });
    });

    return true;
  } catch (error) {
    console.error("CommentSync Title Row failed to show a comment", error, comment);
    return false;
  }
}

function renderCommentText(element, text, timestamp) {
  element.replaceChildren();
  const flattenedText = text.replace(/\s*\r?\n\s*/g, " ");

  const timestampIndex = flattenedText.indexOf(timestamp);
  if (timestampIndex === -1) {
    element.textContent = flattenedText;
    return;
  }

  element.appendChild(document.createTextNode(flattenedText.slice(0, timestampIndex)));

  const strong = document.createElement("strong");
  strong.textContent = timestamp;
  element.appendChild(strong);

  element.appendChild(
    document.createTextNode(flattenedText.slice(timestampIndex + timestamp.length)),
  );
}

function hideOverlay() {
  if (!overlayElement) {
    return;
  }

  if (revealFrame) {
    cancelAnimationFrame(revealFrame);
    revealFrame = null;
  }

  overlayElement.classList.add("commentsync-hiding");
  overlayElement.classList.remove("commentsync-visible");
}

async function isActiveFunc() {
  const state = await getSyncStorage("active");
  return state?.active === undefined || state?.active === null || state.active;
}

function resetVariables() {
  hideOverlay();
  clearTimeout(monitorRetryTimer);
  clearTimeout(queueRetryTimer);
  clearTimeout(scanRetryTimer);
  fallbackAbortController?.abort();
  fallbackAbortController = null;
  monitoringInitialized = false;
  isDisplaying = false;
  comments = [];
  commentsQueue = [];
  fallbackFetchVideoId = null;
  monitoredVideo?.removeEventListener("timeupdate", handleTimeUpdate);
  monitoredVideo?.removeEventListener("seeking", handleSeeking);
  monitoredVideo = null;
  previousVideoTime = 0;
}

window.addEventListener("load", scheduleMain);
window.addEventListener("pageshow", scheduleMain);
window.addEventListener("popstate", scheduleMain);
window.addEventListener("yt-navigate-finish", scheduleMain);
window.addEventListener("yt-page-data-updated", scheduleMain);
watchLocation(scheduleMain);
scheduleMain();

function getSyncStorage(keys) {
  if (usingBrowserPromiseApi) {
    return extensionApi.storage.sync.get(keys);
  }

  return new Promise((resolve, reject) => {
    extensionApi.storage.sync.get(keys, (items) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items);
    });
  });
}

function sendRuntimeMessage(message) {
  if (usingBrowserPromiseApi) {
    return extensionApi.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
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
  sendResponse(true);

  if (message.type === "comments_update") {
    if (message.video_id && message.video_id !== activeVideoId) {
      return;
    }

    addComments(message.comments);
  }

  if (message.type === "comments_fetch_complete") {
    if (message.video_id && message.video_id !== activeVideoId) {
      return;
    }

    console.info(`CommentSync Title Row loaded ${message.count} timestamped comments`);
  }

  if (message.type === "comments_fetch_error") {
    if (message.video_id && message.video_id !== activeVideoId) {
      return;
    }

    console.error(`CommentSync Title Row comment fetch failed: ${message.message}`);
    runFallbackFetch(message.video_id || activeVideoId, runId);
  }
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.active) {
    return;
  }

  const nextActiveState = changes.active.newValue;
  if (typeof nextActiveState !== "boolean" || nextActiveState === isActive) {
    return;
  }

  isActive = nextActiveState;
  if (!isActive) {
    runId += 1;
    activeVideoId = null;
    resetVariables();
    removeInterface();
    sendRuntimeMessage({ type: "cancel_comments" }).catch((error) => {
      console.error("CommentSync Title Row failed to cancel background comments", error);
    });
    return;
  }

  scheduleMain();
});
