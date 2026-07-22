import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("uses the least privileged top-frame content-script configuration", () => {
  assert.equal(manifest.version, "1.0.31");
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.deepEqual(manifest.content_scripts[0].js, ["shared/core.js", "content/content.js"]);
});

test("keeps the Firefox background entry module-based", () => {
  assert.deepEqual(manifest.background, {
    scripts: ["background/background.js"],
    type: "module",
  });
  assert.equal(manifest.browser_specific_settings.gecko.id, "commentsync-title-row@local.fork");
});
