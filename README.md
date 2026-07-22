# CommentSync Title Row

A cross-browser WebExtension fork of CommentSync that shows timestamped YouTube comments in the metadata row between the channel information and the like/share controls.

## Build and test

The project uses only Node's built-in test runner and the system `zip` command:

```bash
npm test
npm run build
# or run syntax checks, tests, and both builds together
npm run check
```

Builds are written to `web-ext-artifacts/`:

- `firefox-VERSION/` and `commentsync-title-row-VERSION-firefox.xpi`
- `chrome-VERSION/` and `commentsync-title-row-VERSION-chrome.zip`

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose `Load Temporary Add-on`.
3. Select `manifest.json` from this folder.
4. Open a YouTube video with timestamped comments.

The generated Firefox `.xpi` can also be loaded temporarily from the same Firefox debugging page.

## Load in Chrome or Atlas

1. Run `npm run build`.
2. Open `chrome://extensions` (or `atlas://extensions` in Atlas).
3. Enable Developer mode and choose **Load unpacked**.
4. Select `web-ext-artifacts/chrome-VERSION`.

## Notes

- Based on CommentSync 1.0.3, which is listed on Mozilla Add-ons under MPL-2.0.
- `shared/core.js` is the single source for timestamp parsing, comment extraction, queue grouping, and resilient YouTube requests in both browsers.
- The original corner-position setting was removed because this fork always renders inline in the title/action row.
- The original Mozilla signing metadata is not included in this fork.
