# CommentSync Title Row

A local fork of CommentSync that shows timestamped YouTube comments in the metadata row between the channel information and the like/share controls.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose `Load Temporary Add-on`.
3. Select `manifest.json` from this folder.
4. Open a YouTube video with timestamped comments.

The packaged file `commentsync-title-row-1.0.25.xpi` can also be loaded temporarily from the same Firefox debugging page.

## Notes

- Based on CommentSync 1.0.3, which is listed on Mozilla Add-ons under MPL-2.0.
- The original corner-position setting was removed because this fork always renders inline in the title/action row.
- The original Mozilla signing metadata is not included in this fork.
