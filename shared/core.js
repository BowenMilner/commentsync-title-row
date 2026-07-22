(function initializeCommentSyncCore(globalScope) {
  const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00";
  const TIMESTAMP_PATTERN_SOURCE = String.raw`(?<!\d)(?:(\d{1,3}):)?(\d{1,3}):([0-5]\d)(?!\d)`;

  class HttpError extends Error {
    constructor(status, url, bodyPreview = "") {
      super(`Request failed with HTTP ${status}: ${url}${bodyPreview ? ` (${bodyPreview})` : ""}`);
      this.name = "HttpError";
      this.status = status;
    }
  }

  function timestampPattern(global = false) {
    return new RegExp(TIMESTAMP_PATTERN_SOURCE, global ? "g" : "");
  }

  function parseTimestamp(timestamp) {
    const parts = String(timestamp).split(":").reverse();
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
    if (!text) {
      return [];
    }

    const pattern = timestampPattern(true);
    const timestamps = [];
    let match;

    while ((match = pattern.exec(text))) {
      const time = parseTimestamp(match[0]);
      if (time !== null) {
        timestamps.push({
          value: match[0],
          time,
          from: match.index,
          to: pattern.lastIndex,
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
    const previous = timestamps[index - 1];
    const lineStart = String(text).lastIndexOf("\n", current.from - 1) + 1;
    const from = !previous || lineStart >= previous.to ? lineStart : current.from;
    const nextLineStart = next ? String(text).lastIndexOf("\n", next.from - 1) + 1 : -1;
    const to = next ? (nextLineStart > current.from ? nextLineStart : next.from) : text.length;

    return text.slice(from, to).trim();
  }

  function fallbackCommentId(text, identity = "") {
    const input = `${identity}\u0000${text}`;
    let hash = 0;

    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
    }

    return `fallback-${hash.toString(36)}`;
  }

  function timestampsAreAscending(timestamps) {
    return timestamps.every(
      (timestamp, index) => index === 0 || timestamp.time >= timestamps[index - 1].time,
    );
  }

  function isChaptersComment(text, timestamps) {
    if (timestamps.length < 3) {
      return false;
    }

    const normalizedText = String(text);
    const lines = normalizedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const startsNearBeginning = timestamps[0].time <= 30 && timestamps[0].from <= 24;

    if (lines.length >= 3) {
      const tokenPattern = timestampPattern(false);
      const timestampLineCount = lines.filter((line) => tokenPattern.test(line)).length;
      if (startsNearBeginning && timestampLineCount >= 3 && timestampLineCount / lines.length >= 0.6) {
        return true;
      }
    }

    if (timestamps.length >= 5 && startsNearBeginning && timestampsAreAscending(timestamps)) {
      return normalizedText.length / timestamps.length <= 80;
    }

    return false;
  }

  function normalizeNumberToken(token, hasMultiplier) {
    const compact = token.replace(/[\s\u00a0\u202f]/g, "");
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      const decimal = lastComma > lastDot ? "," : ".";
      const thousands = decimal === "," ? /\./g : /,/g;
      return compact.replace(thousands, "").replace(decimal, ".");
    }

    if (lastComma !== -1) {
      const decimalDigits = compact.length - lastComma - 1;
      if (hasMultiplier && decimalDigits > 0 && decimalDigits <= 2) {
        return compact.replace(/,/g, ".");
      }
      return compact.replace(/,/g, "");
    }

    if ((compact.match(/\./g) || []).length > 1) {
      return compact.replace(/\./g, "");
    }

    return compact;
  }

  function parseVoteCount(value) {
    if (!value) {
      return 0;
    }

    const normalized = String(value).trim().toUpperCase();
    const multipliers = [
      { markers: ["B"], value: 1_000_000_000 },
      { markers: ["M"], value: 1_000_000 },
      { markers: ["K", "천"], value: 1_000 },
      { markers: ["万", "萬", "만"], value: 10_000 },
      { markers: ["亿", "億"], value: 100_000_000 },
    ];
    const multiplierEntry = multipliers.find((entry) =>
      entry.markers.some((marker) => normalized.includes(marker)),
    );
    const token = normalized.match(/[0-9][0-9.,\s\u00a0\u202f]*/)?.[0];

    if (!token) {
      return 0;
    }

    const amount = Number.parseFloat(normalizeNumberToken(token, Boolean(multiplierEntry)));
    if (Number.isNaN(amount)) {
      return 0;
    }

    return Math.round(amount * (multiplierEntry?.value || 1));
  }

  function getContinuationItems(response) {
    const endpoints = response?.onResponseReceivedEndpoints;
    if (!Array.isArray(endpoints)) {
      return null;
    }

    const items = endpoints.flatMap((endpoint) => {
      const candidate =
        endpoint?.appendContinuationItemsAction?.continuationItems ||
        endpoint?.reloadContinuationItemsCommand?.continuationItems;
      return Array.isArray(candidate) ? candidate : [];
    });

    return items.length > 0 ? items : null;
  }

  function extractComment(thread, response) {
    if (thread.comment?.commentRenderer) {
      const renderer = thread.comment.commentRenderer;
      return {
        id: renderer.commentId || "",
        name: renderer.authorText?.simpleText || "",
        avatar: renderer.authorThumbnail?.thumbnails?.[0]?.url || "",
        likes: parseVoteCount(renderer.voteCount?.simpleText),
        text: renderer.contentText?.runs?.map((run) => run.text || "").join("") || "",
      };
    }

    if (thread.commentViewModel?.commentViewModel) {
      const viewModel = thread.commentViewModel.commentViewModel;
      const mutation = response?.frameworkUpdates?.entityBatchUpdate?.mutations?.find(
        (entry) => entry.entityKey === viewModel.commentKey,
      );
      const payload = mutation?.payload?.commentEntityPayload;
      if (!payload) {
        return null;
      }

      return {
        id: payload.properties?.commentId || "",
        name: payload.author?.displayName || "",
        avatar: payload.author?.avatarThumbnailUrl || "",
        likes: parseVoteCount(
          payload.toolbar?.likeCountLiked ??
            payload.toolbar?.likeCountNotliked ??
            payload.toolbar?.likeCount,
        ),
        text: payload.properties?.content?.content || "",
      };
    }

    return null;
  }

  function extractThreadTimestampComments(thread, response, stats = null) {
    const comment = extractComment(thread, response);
    if (!comment?.text) {
      return [];
    }

    const timestamps = findTimestampContexts(comment.text);
    if (timestamps.length === 0) {
      return [];
    }

    if (stats) {
      stats.timestamped += timestamps.length;
    }

    if (isChaptersComment(comment.text, timestamps)) {
      if (stats) {
        stats.chapterSkipped += 1;
      }
      return [];
    }

    if (stats && (!comment.id || !comment.name || !comment.avatar)) {
      stats.missingMetadata += 1;
    }

    const identity = `${comment.name}\u0000${comment.avatar}`;
    const sourceCommentId = comment.id || fallbackCommentId(comment.text, identity);
    return timestamps.map((timestamp, index) => ({
      id: `${sourceCommentId}-${timestamp.time}-${index}`,
      sourceCommentId,
      name: comment.name || "YouTube commenter",
      avatar: comment.avatar || "",
      likes: comment.likes,
      time: timestamp.time,
      timestamp: timestamp.value,
      displayText: getTimestampSegment(comment.text, timestamps, index),
      text: comment.text,
      processed: false,
      metadataIncomplete: !comment.id || !comment.name || !comment.avatar,
    }));
  }

  function commentsContinuationToken(response) {
    const body = Array.isArray(response)
      ? response.find((entry) => entry?.response)?.response
      : response?.response;
    const contents = body?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
    if (!Array.isArray(contents)) {
      return null;
    }

    const commentSection = contents.find(
      (entry) =>
        entry.itemSectionRenderer?.sectionIdentifier === "comment-item-section",
    );
    return (
      commentSection?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer
        ?.continuationEndpoint?.continuationCommand?.token || null
    );
  }

  function abortError(signal) {
    return signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }

  function wait(milliseconds, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }

      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError(signal));
        },
        { once: true },
      );
    });
  }

  async function fetchJson(url, options = {}, config = {}) {
    const timeoutMs = config.timeoutMs ?? 12_000;
    const retries = config.retries ?? 2;
    const externalSignal = options.signal || null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (externalSignal?.aborted) {
        throw abortError(externalSignal);
      }

      const controller = new AbortController();
      const forwardAbort = () => controller.abort(abortError(externalSignal));
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(
        () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")),
        timeoutMs,
      );

      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        if (!response.ok) {
          throw new HttpError(response.status, url, text.slice(0, 120).replace(/\s+/g, " "));
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("json") && !/^[\s]*[\[{]/.test(text)) {
          throw new TypeError(`Expected JSON from ${url}, received ${contentType || "unknown content"}`);
        }

        return JSON.parse(text);
      } catch (error) {
        if (externalSignal?.aborted) {
          throw abortError(externalSignal);
        }

        const retryable =
          error?.name === "TimeoutError" ||
          error instanceof TypeError ||
          error instanceof SyntaxError ||
          (error instanceof HttpError && (error.status === 429 || error.status >= 500));
        if (!retryable || attempt >= retries) {
          throw error;
        }

        await wait(300 * 2 ** attempt, externalSignal);
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", forwardAbort);
      }
    }

    throw new Error(`Failed to fetch ${url}`);
  }

  async function fetchVideo(videoId, signal = null) {
    return await fetchJson(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&pbj=1`,
      {
        credentials: "omit",
        headers: {
          "X-Youtube-Client-Name": "1",
          "X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION,
        },
        signal,
      },
    );
  }

  async function fetchNext(continuation, signal = null) {
    return await fetchJson(
      `https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}`,
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB", clientVersion: INNERTUBE_CLIENT_VERSION },
          },
          continuation,
        }),
        signal,
      },
    );
  }

  async function fetchCommentsPage(videoId, continuation = null, signal = null, stats = null) {
    let nextToken = continuation;
    if (!nextToken) {
      nextToken = commentsContinuationToken(await fetchVideo(videoId, signal));
    }
    if (!nextToken) {
      return { comments: [], nextToken: null };
    }

    const response = await fetchNext(nextToken, signal);
    const items = getContinuationItems(response);
    if (!items) {
      return { comments: [], nextToken: null };
    }

    const comments = [];
    let followingToken = null;
    for (const item of items) {
      if (item.commentThreadRenderer) {
        if (stats) {
          stats.threads += 1;
        }
        comments.push(...extractThreadTimestampComments(item.commentThreadRenderer, response, stats));
      } else if (item.continuationItemRenderer) {
        followingToken =
          item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
          followingToken;
      }
    }

    return { comments, nextToken: followingToken };
  }

  function selectQueueComments(matchingComments, groupWindowSeconds = 3, maxPerGroup = 3) {
    const groups = [];
    matchingComments
      .slice()
      .sort((a, b) => a.time - b.time || (b.likes || 0) - (a.likes || 0))
      .forEach((comment) => {
        let group = groups.find(
          (candidate) => Math.abs(candidate.latestTime - comment.time) <= groupWindowSeconds,
        );
        if (!group) {
          group = { latestTime: comment.time, comments: [] };
          groups.push(group);
        }
        group.latestTime = Math.max(group.latestTime, comment.time);
        group.comments.push(comment);
      });

    return groups.flatMap((group) =>
      group.comments
        .sort((a, b) => (b.likes || 0) - (a.likes || 0) || a.time - b.time)
        .slice(0, maxPerGroup)
        .map((comment, index, selectedGroup) => ({ ...comment, groupSize: selectedGroup.length })),
    );
  }

  globalScope.CommentSyncCore = Object.freeze({
    HttpError,
    commentsContinuationToken,
    extractThreadTimestampComments,
    fallbackCommentId,
    fetchCommentsPage,
    fetchJson,
    findTimestampContexts,
    getContinuationItems,
    getTimestampSegment,
    isChaptersComment,
    parseTimestamp,
    parseVoteCount,
    selectQueueComments,
  });
})(globalThis);
