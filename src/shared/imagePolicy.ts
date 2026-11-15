// When does an image make a post "explicit" or "suggestive"?
//
// The image model (NSFWJS) gives probabilities for Porn, Hentai, Sexy, Drawing
// and Neutral. Porn + Hentai → the "explicit" label; Sexy → "suggestive".
// "Sexy" is broad: bikinis and revealing clothing, but it also fires on
// close-ups of faces/skin and dark, blurry frames. So:
//  - explicit hides at moderate confidence;
//  - suggestive needs high confidence;
//  - video thumbnails (often dark / mid-transition frames) need more confidence;
//  - if the post's text is clearly about something else, the image must be more
//    certain; if the text itself is sexualised, it can be less certain.
import type { Strictness } from "./types.ts";

export interface ImageScore {
  /** Porn + Hentai probability. */
  explicit: number;
  /** "Sexy" (suggestive, revealing) probability. */
  sexy: number;
  /** Video thumbnail rather than a photo. */
  video: boolean;
}

export const IMAGE_POLICY: Record<Strictness, { explicit: number; sexy: number }> = {
  relaxed: { explicit: 0.75, sexy: 0.92 },
  balanced: { explicit: 0.55, sexy: 0.8 },
  strict: { explicit: 0.4, sexy: 0.7 },
};
const VIDEO_PENALTY = 0.1;
const CONTEXT_SHIFT = 0.1;

export type TextContext = "sexual" | "other-topic" | "unclear";

export function isVideoThumb(url: string): boolean {
  return /(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)/.test(url);
}

/** Is this image explicit, suggestive, or neither, given the strictness and the post's text? */
export function judgeImage(
  img: ImageScore,
  strictness: Strictness,
  context: TextContext,
): "explicit" | "suggestive" | undefined {
  const base = IMAGE_POLICY[strictness];
  const shift =
    (img.video ? VIDEO_PENALTY : 0) +
    (context === "other-topic" ? CONTEXT_SHIFT : context === "sexual" ? -CONTEXT_SHIFT : 0);
  const explicitT = Math.min(0.98, base.explicit + shift);
  const sexyT = Math.min(0.99, base.sexy + shift);
  if (img.explicit >= explicitT) return "explicit";
  if (img.sexy >= sexyT) return "suggestive";
  return undefined;
}
