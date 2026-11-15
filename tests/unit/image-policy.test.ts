import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeImage, isVideoThumb } from "../../src/shared/imagePolicy.ts";

test("explicit images hide at moderate confidence", () => {
  assert.equal(judgeImage({ explicit: 0.7, sexy: 0.2, video: false }, "balanced", "unclear"), "explicit");
});

test("'Sexy' (bikinis, revealing clothes) needs high confidence", () => {
  assert.equal(judgeImage({ explicit: 0.05, sexy: 0.7, video: false }, "balanced", "unclear"), undefined);
  assert.equal(judgeImage({ explicit: 0.05, sexy: 0.85, video: false }, "balanced", "unclear"), "suggestive");
});

test("a dark video thumbnail of a face, on a post clearly about something else, is not hidden", () => {
  // The kind of false positive seen on a late-night TV clip.
  assert.equal(judgeImage({ explicit: 0.15, sexy: 0.85, video: true }, "strict", "other-topic"), undefined);
  assert.equal(judgeImage({ explicit: 0.15, sexy: 0.85, video: true }, "balanced", "other-topic"), undefined);
});

test("sexual text lowers the bar for the image", () => {
  assert.equal(judgeImage({ explicit: 0.1, sexy: 0.72, video: false }, "balanced", "sexual"), "suggestive");
});

test("video thumbnails are recognised", () => {
  assert.ok(isVideoThumb("https://pbs.twimg.com/amplify_video_thumb/123/img/abc.jpg?name=small"));
  assert.ok(isVideoThumb("https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/abc.jpg"));
  assert.ok(!isVideoThumb("https://pbs.twimg.com/media/abc?format=jpg&name=small"));
});
