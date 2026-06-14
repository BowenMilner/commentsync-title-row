# Project Handoff Notes

## What This Project Is

This is a Firefox WebExtension fork/adaptation of CommentSync. The goal is to show timestamped YouTube comments in the space between the channel/remix area and the like/share/action buttons, instead of as a corner overlay on top of the video.

Current GitHub repo:

- `https://github.com/BowenMilner/commentsync-title-row`

The user cares most about the actual viewing feel on YouTube. Small visual regressions matter. Prefer changing one UX variable at a time and packaging a new `.xpi` so they can compare builds.

## Current Baseline

The current source is version `1.0.26`.

Important baseline behavior:

- Uses centered, lifted pill placement.
- Background comment fetching is the primary path; the in-page Innertube fetch is now a fallback only when the background request is rejected or reports an error. Do not reintroduce parallel duplicate fetches.
- The declarative net request rule only strips `Origin` for `www.youtube.com/youtubei/v1/next`. Do not broaden it back to all YouTube XHRs unless there is a proven need.
- YouTube response parsing should fail soft. Missing/changed private response fields should return no comments/token, not throw.
- Removed the title-risk detection from `1.0.25` because it made the pill too low too often.
- Keeps the queue/grouping improvements from `1.0.23`.
- Keeps YouTube SPA navigation fixes from `1.0.22`.
- Keeps defensive rendering logs/guards from `1.0.21`.
- Keeps timestamp-list segmenting, so a comment with many timestamps shows only the relevant timestamp segment instead of the whole huge comment.

The latest packaged file in the parent workspace is:

- `/home/bowen/Documents/youtube comment popup/commentsync-title-row-1.0.26.xpi`

Package from inside `title-row-commentsync` with:

```bash
zip -r -FS ../commentsync-title-row-VERSION.xpi . -x '.git/*' '.gitignore' 'AGENTS.md'
```

Be careful: after the repo was initialized, a package accidentally included `.git/`, and a later rebuild briefly included `AGENTS.md`. Always exclude `.git/*`, `.gitignore`, and `AGENTS.md`, then verify with `unzip -l`.

The parent folder also has older extracted source folders and package files:

- `commentsync-src` / `commentsync-1.0.3.xpi`
- `youtube-timestamps-src` / `youtube-timestamps-1.0.1.xpi`

These were cleaned so `web-ext lint` reports zero warnings, but they are not the active fork. Do not mix their code into `title-row-commentsync` unless intentionally porting a specific behavior.

## User Preferences

- The best visual baseline before the final push was `1.0.23`.
- The user strongly prefers the pill not to be too low. The very first complaint was that the pill placement was slightly too low.
- The centered lifted pill feels better than left-anchored placement.
- Avoid over-clever dynamic layout logic unless necessary. A previous dynamic measurement attempt in `1.0.18` caused comments to stop displaying.
- Test with fresh YouTube tabs after reloading a temporary Firefox extension. Stale content scripts in existing YouTube tabs caused confusion and made older builds appear broken.
- The user likes detection being broad/accurate, but the playback experience should not feel stale or backed up.
- The user prefers discussing UX changes before implementation when the behavior is subjective.

## Known Good / Bad Version History

- `1.0.17`: Worked and had simpler layout behavior.
- `1.0.21`: Worked after fresh-tab testing; added render guardrails and logs.
- `1.0.22`: Added stronger YouTube SPA navigation handling. This addressed cases where clicking between videos sometimes failed to initialize.
- `1.0.23`: Best behavior baseline for UX before later layout experiments. Added comment grouping, top-liked filtering, stale dropping, and dynamic display durations.
- `1.0.24`: Removed upward lift globally to avoid title overlap. User found the pill too low too often.
- `1.0.25`: Tried title-risk detection based on title right edge reaching into the pill zone. User disliked this because it lowered the pill too often.
- `1.0.26`: Removed title-risk detection and restored centered lifted behavior, keeping queue improvements. This is the currently pushed state.

Avoid returning to the `1.0.18` style of runtime width/lift measurement. It broke visible display and was hard to reason about.

## Core Files

- `manifest.json`: Extension metadata and version.
- `content/content.js`: Main UI, YouTube navigation handling, comment queueing, rendering, in-page fallback fetch.
- `content/content.css`: Pill placement, sizing, animation.
- `background/background.js`: Background fetch coordinator, sends comments to content script.
- `background/youtubei.js`: YouTube comment fetch/parser using Innertube endpoints.
- `popup/popup.html` and `popup/popup.js`: Minimal enable/disable UI.
- `rules.json`: Narrow header rule for the Innertube continuation endpoint only.

## Fetching / Fallback Notes

The active fork intentionally avoids doing the same private YouTube API pagination twice:

- `content/content.js` asks the background script to fetch comments.
- `background/background.js` responds immediately if it can accept the request, then streams comment updates back to the tab.
- The in-page `fetchIncrementalComments` fallback runs only when the background request is rejected, cannot be sent, or the background script emits `comments_fetch_error`.
- The normal DOM scan still runs after a short delay as a separate fallback for comments already rendered on the page.

Keep this ordering. Duplicate background + in-page Innertube pagination can create unnecessary request bursts and make YouTube failures harder to debug.

The parsing helpers in both `content/content.js` and `background/youtubei.js` use optional chaining around YouTube's private response shape. If YouTube changes a response, the extension should quietly produce no comments from that path and let the fallback paths continue.

## Detection Logic

Detection is intentionally broader than the original CommentSync:

- Extracts every valid timestamp in a comment, not just the first.
- Handles formats like `1:45`, `01:05`, `1:02:03`, `0:00`, and long-video timestamps like `123:45`.
- Skips chapter-list comments when a comment has 3+ timestamps and starts at `0:00`.
- Does not drop long newer-format YouTube comments.
- Does not prune dense clusters during fetch. Queueing handles UX capping later.

Important: do not weaken timestamp detection casually. It took several iterations to match the user's expectations and the behavior of the separate "YouTube Timestamps" extension.

## Timestamp List Segmenting

For comments with many timestamps, each timestamp event uses a `displayText` segment:

- Single-timestamp comments show the whole comment.
- Multi-timestamp comments show only from that timestamp up to the next timestamp.

This fixed huge timestamp-list comments filling the pill with unrelated moments.

## Queue / Timing Logic

Current intended behavior:

- Comments are eligible from `timestamp` to `timestamp + 6s`.
- Comments within a `3s` window are grouped.
- Each group keeps the top `3` comments by likes.
- Queued comments are dropped if they are more than `8s` late.
- Display duration is dynamic:
  - minimum `3s`
  - max `5.5s`
  - longer comments get more time
  - grouped comments share max total group time of `9s`
- Gap between comments is `0.5s`.

This replaced the old fixed `6s` per comment behavior, where 4 comments could create a 25-second backlog.

## Layout Notes

Current placement:

- Slot is inserted before `ytd-watch-metadata #actions`.
- Pill is centered in that slot.
- Slot is lifted by `translateY(-8px)`.
- Pill max width is capped at `820px`.
- Text line clamp is 3 lines on desktop, 2 lines on narrow layouts.

Things tried and rejected:

- Left anchoring: caused awkward clipping/overlap and felt worse than centered placement.
- Preserving multi-line comments visually: caused page height/pill length jumps and was reverted.
- Dynamic geometry-based layout: broke display in practice.
- Lowering pill globally: avoided title overlap but felt too low.
- Title-risk detection: avoided some overlap but triggered too often and felt too low.

If improving title avoidance later, prefer small CSS-only or class-only changes. Do not change fetch/queue/render logic in the same build.

## Firefox Testing Gotchas

Temporary add-ons and YouTube SPA navigation are easy to misread:

- Always remove/reload the extension in `about:debugging#/runtime/this-firefox`.
- Close the old YouTube video tab.
- Open a fresh YouTube video tab after loading a new build.
- Existing YouTube tabs can keep stale content scripts.
- Firefox showing `Background script: Stopped` can be normal for MV3/event backgrounds.
- Run `web-ext lint` on the source folder before packaging. It catches Firefox manifest issues and unsafe DOM patterns that plain JS syntax checks miss.

Useful console logs in the YouTube page:

- `CommentSync Title Row loaded X timestamped comments`
- `CommentSync Title Row playback monitor attached`
- `CommentSync Title Row accepted X new comment(s); Y total`
- `CommentSync Title Row queued X/Y comment(s)`
- `CommentSync Title Row dropped stale comment...`

If comments do not appear, first check whether comments are loaded, queued, or failing to render from those logs.

## Git / Publishing

Local repo:

- `/home/bowen/Documents/youtube comment popup/title-row-commentsync`

Remote:

- `origin https://github.com/BowenMilner/commentsync-title-row.git`

Current pushed commit after `1.0.26`:

- `fb34973 Center lifted title row pill`

The parent folder contains many old `.xpi` files and unpacked add-on folders. Do not publish from the parent folder. Work from `title-row-commentsync`.

## Validation Checklist

Before handing a build to the user:

```bash
node --check content/content.js
node --check background/background.js
node --check background/youtubei.js
python -m json.tool manifest.json
npx --yes web-ext lint -s .
zip -r -FS ../commentsync-title-row-VERSION.xpi . -x '.git/*' '.gitignore' 'AGENTS.md'
unzip -t ../commentsync-title-row-VERSION.xpi
unzip -l ../commentsync-title-row-VERSION.xpi
```

Check that the `.xpi` does not contain `.git/`, `.gitignore`, or `AGENTS.md`.

For package-level verification, unpack the `.xpi` to `/tmp`, diff it against source while excluding repo-only files, and run `web-ext lint` on the unpacked copy:

```bash
mkdir -p /tmp/commentsync-title-row-check
unzip -qo ../commentsync-title-row-VERSION.xpi -d /tmp/commentsync-title-row-check
diff -qr . /tmp/commentsync-title-row-check -x .git -x .gitignore -x AGENTS.md
npx --yes web-ext lint -s /tmp/commentsync-title-row-check
```

If source changes should be saved:

```bash
git status -sb
git add <files>
git commit -m "<short message>"
git push
```
