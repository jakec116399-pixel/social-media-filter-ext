// The trained topic classifier ("head"): one-vs-rest logistic regression on top
// of the sentence embedding. Trained by training/train-head.ts on real tweets.
import type { TopicId } from "./types.ts";

/**
 * Classes the head predicts. Most are our topics directly; two are internal:
 *  - newsSocial: news *and* politics (the training data doesn't separate them);
 *    the example-post scores then decide which of the two a post is.
 *  - business: business/entrepreneur posts. Never hidden by itself; it just
 *    gives those posts a home so they aren't forced into another topic.
 */
export const HEAD_CLASSES = [
  "sports",
  "gossip",
  "entertainment",
  "tech",
  "learning",
  "fitness",
  "lifestyle",
  "personal",
  "relationships",
  "newsSocial",
  "business",
] as const;
export type HeadClass = (typeof HEAD_CLASSES)[number];

/** Our topics the head decides (instead of example-post matching). */
export const HEAD_TOPICS: TopicId[] = [
  "sports",
  "gossip",
  "entertainment",
  "tech",
  "learning",
  "fitness",
  "lifestyle",
  "personal",
  "relationships",
  "politics",
  "news",
];

export interface TopicHead {
  model: string;
  pooling: "mean" | "cls";
  classes: string[];
  W: number[][];
  b: number[];
  source: string;
}

export function headProbs(head: TopicHead, v: Float32Array): Record<HeadClass, number> {
  const out = {} as Record<HeadClass, number>;
  head.classes.forEach((c, k) => {
    const w = head.W[k];
    let z = head.b[k];
    for (let d = 0; d < w.length; d++) z += w[d] * v[d];
    out[c as HeadClass] = 1 / (1 + Math.exp(-z));
  });
  return out;
}
