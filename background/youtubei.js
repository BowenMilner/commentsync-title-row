const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00";
const TIMESTAMP_PATTERN = /(?<!\d)(?:(\d{1,3}):)?(\d{1,3}):([0-5]\d)(?!\d)/g;

export async function fetchCommentsPage(videoId, continuation = null) {
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
  const comments = [];
  let followingToken = null;

  if (!items) {
    return { comments: [], nextToken: null };
  }

  for (const item of items) {
    if (item.commentThreadRenderer) {
      comments.push(...extractThreadTimestampComments(item.commentThreadRenderer, commentsResponse));
    } else if (item.continuationItemRenderer) {
      followingToken =
        item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
  }

  return { comments, nextToken: followingToken };
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

function findTimestampContexts(text) {
  const timestamps = [];
  TIMESTAMP_PATTERN.lastIndex = 0;

  let match;
  while ((match = TIMESTAMP_PATTERN.exec(text))) {
    const time = parseTimestamp(match[0]);

    if (time !== null) {
      timestamps.push({
        value: match[0],
        time,
        from: match.index,
        to: TIMESTAMP_PATTERN.lastIndex,
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

function parseTimestamp(timestamp) {
  const parts = timestamp.split(":").reverse();
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

function commentsContinuationToken(response) {
  const body = Array.isArray(response) ? response.find((entry) => entry.response).response : response.response;
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
