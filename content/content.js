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

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00";
const timestampRegex = /(?<!\d)(?:(\d{1,3}):)?(\d{1,3}):([0-5]\d)(?!\d)/g;
const SLOT_ID = "commentsync-title-row-slot";
const OVERLAY_ID = "commentsync-title-row-comment";
const COMMENT_TRIGGER_WINDOW_SECONDS = 6;
const COMMENT_GROUP_WINDOW_SECONDS = 3;
const MAX_COMMENTS_PER_GROUP = 3;
const MAX_QUEUE_LATENESS_SECONDS = 8;
const MAX_GROUP_DISPLAY_MS = 9000;
const BETWEEN_COMMENT_DELAY_MS = 500;

function locationChange(callback) {
  let currentUrl = location.href;
  const observer = new MutationObserver(() => {
    if (currentUrl !== document.location.href) {
      currentUrl = document.location.href;
      callback();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

async function main() {
  const currentRunId = ++runId;
  resetVariables();
  isActive = await isActiveFunc();

  const videoId = getVideoId();
  if (!videoId) {
    activeVideoId = null;
    removeInterface();
    return;
  }

  activeVideoId = videoId;

  createInterface();
  browser.runtime
    .sendMessage({ type: "comments", video_id: videoId })
    .catch((error) =>
      console.error("CommentSync Title Row failed to request background comments", error),
    );
  fetchIncrementalComments(videoId).catch((error) => {
    if (currentRunId === runId) {
      console.error("CommentSync Title Row failed to fetch fallback comments in-page", error);
    }
  });
  setTimeout(() => {
    if (currentRunId === runId) {
      scanComments();
    }
  }, 5000);
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

  updateTitleRisk();
}

function updateTitleRisk() {
  if (!slotElement) {
    return;
  }

  const title = document.querySelector("ytd-watch-metadata h1");
  if (!title) {
    slotElement.classList.remove("commentsync-title-risk");
    return;
  }

  const titleRect = title.getBoundingClientRect();
  const slotRect = slotElement.getBoundingClientRect();
  const titleReachesPillZone = titleRect.right > slotRect.left - 24;

  slotElement.classList.toggle("commentsync-title-risk", titleReachesPillZone);
}

function removeInterface() {
  const existingSlot = document.getElementById(SLOT_ID);
  if (existingSlot) {
    existingSlot.remove();
  }

  overlayElement = null;
  slotElement = null;
}

function startMonitoring() {
  const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
  videoContainer = document.querySelector("#container .html5-video-player");
  if (!video) {
    setTimeout(startMonitoring, 500);
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
    processQueue();
  }
}

async function processQueue() {
  if (isDisplaying || commentsQueue.length === 0 || isAdPlaying() || !isActive) {
    return;
  }

  if (isAdPlaying()) {
    setTimeout(processQueue, 2000);
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
    processQueue();
    return;
  }
  await delay(getDisplayDuration(nextComment));
  hideOverlay();
  isDisplaying = false;
  await delay(BETWEEN_COMMENT_DELAY_MS);
  processQueue();
}

function selectQueueComments(matchingComments) {
  const groups = [];

  matchingComments
    .slice()
    .sort((a, b) => a.time - b.time || (b.likes || 0) - (a.likes || 0))
    .forEach((comment) => {
      let group = groups.find(
        (candidate) => Math.abs(candidate.time - comment.time) <= COMMENT_GROUP_WINDOW_SECONDS,
      );

      if (!group) {
        group = { time: comment.time, comments: [] };
        groups.push(group);
      }

      group.comments.push(comment);
    });

  return groups.flatMap((group) =>
    group.comments
      .sort((a, b) => (b.likes || 0) - (a.likes || 0) || a.time - b.time)
      .slice(0, MAX_COMMENTS_PER_GROUP)
      .map((comment, index, selectedGroup) => ({
        ...comment,
        groupSize: selectedGroup.length,
      })),
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

function scanComments() {
  const threads = document.querySelectorAll("ytd-comment-thread-renderer");

  if (threads.length === 0) {
    return;
  }

  for (const thread of threads) {
    const commentText = thread.querySelector("#content-text");
    if (!commentText) {
      return;
    }

    const rawText = commentText.innerText;
    const timestamps = findTimestampContexts(rawText);
    if (timestamps.length === 0 || isChaptersComment(timestamps)) {
      continue;
    }

    const author = thread.querySelector("#author-text span");
    const avatar = thread.querySelector("#author-thumbnail #img");
    const name = author ? author.innerText.trim() : null;
    const avatarUrl = avatar ? avatar.src : "";

    if (!name || !avatarUrl) {
      continue;
    }

    timestamps.forEach((timestamp, index) => {
      const id = `${name}-${timestamp.time}-${index}`;

      if (timestamp.time !== null && !comments.find((comment) => comment.id === id)) {
        comments.push({
          id,
          time: timestamp.time,
          timestamp: timestamp.value,
          displayText: getTimestampSegment(rawText, timestamps, index),
          text: rawText,
          name,
          avatar: avatarUrl,
          processed: false,
        });
      }
    });
  }

  comments.sort((a, b) => a.time - b.time);
}

async function fetchIncrementalComments(videoId) {
  let nextToken = null;
  let pageCount = 0;

  while (pageCount < 10) {
    const { comments: fetchedComments, nextToken: fetchedNextToken } = await fetchCommentsPage(
      videoId,
      nextToken,
    );

    addComments(fetchedComments);

    if (!fetchedNextToken) {
      break;
    }

    nextToken = fetchedNextToken;
    pageCount += 1;
  }
}

function addComments(incomingComments) {
  if (incomingComments.length === 0) {
    return;
  }

  const previousCount = comments.length;
  incomingComments.forEach((incomingComment) => {
    if (!comments.some((comment) => comment.id === incomingComment.id)) {
      comments.push(incomingComment);
    }
  });

  comments.sort((a, b) => a.time - b.time);
  console.info(
    `CommentSync Title Row accepted ${comments.length - previousCount} new comment(s); ${comments.length} total`,
  );

  if (!monitoringInitialized) {
    startMonitoring();
  }
}

async function fetchCommentsPage(videoId, continuation = null) {
  let nextToken = continuation;

  if (!nextToken) {
    const videoResponse = await fetchVideo(videoId);
    nextToken = commentsContinuationToken(videoResponse);
  }

  if (!nextToken) {
    return { comments: [], nextToken: null };
  }

  const commentsResponse = await fetchNext(nextToken);
  const items = getContinuationItems(commentsResponse);
  const fetchedComments = [];
  let followingToken = null;

  if (!items) {
    return { comments: [], nextToken: null };
  }

  for (const item of items) {
    if (item.commentThreadRenderer) {
      fetchedComments.push(
        ...extractThreadTimestampComments(item.commentThreadRenderer, commentsResponse),
      );
    } else if (item.continuationItemRenderer) {
      followingToken =
        item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
  }

  return { comments: fetchedComments, nextToken: followingToken };
}

function getContinuationItems(response) {
  return (
    response.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction?.continuationItems ||
    response.onResponseReceivedEndpoints?.[1]?.reloadContinuationItemsCommand?.continuationItems ||
    null
  );
}

function extractThreadTimestampComments(thread, response) {
  const comment = extractComment(thread, response);

  if (!comment) {
    return [];
  }

  const timestamps = findTimestampContexts(comment.text);

  if (isChaptersComment(timestamps)) {
    return [];
  }

  return timestamps.map((timestamp, index) => ({
    id: `${comment.id}-${timestamp.time}-${index}`,
    sourceCommentId: comment.id,
    name: comment.name,
    avatar: comment.avatar,
    likes: comment.likes,
    time: timestamp.time,
    timestamp: timestamp.value,
    displayText: getTimestampSegment(comment.text, timestamps, index),
    text: comment.text,
    processed: false,
  }));
}

function extractComment(thread, response) {
  if (thread.comment) {
    const renderer = thread.comment.commentRenderer;
    const text = renderer.contentText.runs.map((run) => run.text).join("");

    return {
      id: renderer.commentId,
      name: renderer.authorText?.simpleText || "",
      avatar: renderer.authorThumbnail?.thumbnails?.[0]?.url || "",
      likes: parseVoteCount(renderer.voteCount?.simpleText),
      text,
    };
  }

  if (thread.commentViewModel) {
    const viewModel = thread.commentViewModel.commentViewModel;
    const mutation = response.frameworkUpdates?.entityBatchUpdate?.mutations?.find(
      (entry) => entry.entityKey === viewModel.commentKey,
    );
    const payload = mutation?.payload?.commentEntityPayload;

    if (!payload) {
      return null;
    }

    return {
      id: payload.properties.commentId,
      name: payload.author.displayName,
      avatar: payload.author.avatarThumbnailUrl,
      likes: parseVoteCount(payload.toolbar?.likeCountLiked),
      text: payload.properties.content.content,
    };
  }

  return null;
}

function commentsContinuationToken(response) {
  const body = Array.isArray(response)
    ? response.find((entry) => entry.response).response
    : response.response;
  const commentSection = body.contents.twoColumnWatchNextResults.results.results.contents.find(
    (entry) =>
      entry.itemSectionRenderer &&
      entry.itemSectionRenderer.sectionIdentifier === "comment-item-section",
  );

  return (
    commentSection?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
      ?.continuationEndpoint?.continuationCommand?.token || null
  );
}

async function fetchVideo(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&pbj=1`, {
    credentials: "omit",
    headers: {
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION,
    },
  });

  return await response.json();
}

async function fetchNext(continuation) {
  const body = JSON.stringify({
    context: {
      client: {
        clientName: "WEB",
        clientVersion: INNERTUBE_CLIENT_VERSION,
      },
    },
    continuation,
  });

  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}`,
    {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    },
  );

  return await response.json();
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

    const timestamp = comment.timestamp || findTimestampContexts(comment.text || "")[0]?.value;
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

function getTimeInSeconds(value) {
  const parts = value.split(":").reverse();
  const seconds = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  const hours = Number.parseInt(parts[2] || "0", 10);

  if (Number.isNaN(seconds) || Number.isNaN(minutes) || Number.isNaN(hours)) {
    return null;
  }

  if (seconds > 59 || (parts.length > 2 && minutes > 59)) {
    return null;
  }

  return seconds + minutes * 60 + hours * 3600;
}

function findTimestampContexts(text) {
  const timestamps = [];
  timestampRegex.lastIndex = 0;

  let match;
  while ((match = timestampRegex.exec(text))) {
    const time = getTimeInSeconds(match[0]);

    if (time !== null) {
      timestamps.push({
        value: match[0],
        time,
        from: match.index,
        to: timestampRegex.lastIndex,
      });
    }
  }

  return timestamps;
}

function getTimestampSegment(text, timestamps, index) {
  if (timestamps.length < 2) {
    return text;
  }

  const current = timestamps[index];
  const next = timestamps[index + 1];
  const from = current.from;
  const to = next ? next.from : text.length;

  return text.slice(from, to).trim();
}

function isChaptersComment(timestamps) {
  return timestamps.length >= 3 && timestamps[0].time === 0;
}

function parseVoteCount(value) {
  if (!value) {
    return 0;
  }

  const normalized = String(value).trim().toUpperCase();
  const amount = Number.parseFloat(normalized.replace(/[^0-9.]/g, ""));

  if (Number.isNaN(amount)) {
    return 0;
  }

  if (normalized.includes("M")) {
    return Math.round(amount * 1_000_000);
  }

  if (normalized.includes("K")) {
    return Math.round(amount * 1_000);
  }

  return Math.round(amount);
}

async function isActiveFunc() {
  const state = await browser.storage.sync.get("active");
  return state?.active === undefined || state?.active === null || state.active;
}

function resetVariables() {
  monitoringInitialized = false;
  isDisplaying = false;
  comments = [];
  commentsQueue = [];
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
locationChange(scheduleMain);
scheduleMain();

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  sendResponse(true);

  if (message.type === "isActive") {
    hideOverlay();
    comments.forEach((comment) => {
      comment.processed = false;
    });
    commentsQueue = [];
    isActive = message.status;
  }

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
  }
});
