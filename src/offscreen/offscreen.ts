// Offscreen document: hosts the on-device AI models.
//  - Text: all-MiniLM-L6-v2 sentence embeddings (ONNX, ~23 MB) for zero-shot topic scoring
//  - Images: NSFWJS MobileNetV2 (~3 MB) for sexualised-image detection
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import * as tf from "@tensorflow/tfjs";
import { load as loadNsfw, type NSFWJS } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";
import { TextClassifier, decideText, type TextScores } from "../shared/textModel";
import type { Category, Msg, PostData, Settings, Strictness, Verdict } from "../shared/types";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.useBrowserCache = false;
env.useWasmCache = false;
const onnx = env.backends.onnx as { wasm: { wasmPaths: unknown; numThreads: number } };
onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.mjs"),
  wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm"),
};
onnx.wasm.numThreads = 1;

// ---- Text model ----
let textClf: Promise<TextClassifier> | null = null;
function getTextClassifier(): Promise<TextClassifier> {
  textClf ??= (async () => {
    try {
      const extractor = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
        device: "wasm",
      })) as FeatureExtractionPipeline;
      const clf = new TextClassifier(async (texts) => {
        const out = await extractor(texts, { pooling: "mean", normalize: true });
        const dim = out.dims[1];
        const flat = out.data as Float32Array;
        return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
      });
      await clf.init();
      return clf;
    } catch (e) {
      textClf = null; // allow a retry
      throw e;
    }
  })();
  return textClf;
}

// ---- Image model ----
let nsfwModel: Promise<NSFWJS> | null = null;
function getNsfw(): Promise<NSFWJS> {
  nsfwModel ??= (async () => {
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    return loadNsfw("MobileNetV2", { size: 224, modelDefinitions: [MobileNetV2Model] });
  })();
  return nsfwModel;
}

/** Probability that an image is sexualised (Porn + Hentai + Sexy). */
async function imageScore(url: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const model = await getNsfw();
    const preds = await model.classify(bitmap as unknown as HTMLImageElement, 5);
    const p = (name: string) => preds.find((x) => x.className === name)?.probability ?? 0;
    return p("Porn") + p("Hentai") + p("Sexy");
  } finally {
    bitmap.close();
  }
}

const IMAGE_THRESHOLD: Record<Strictness, number> = { relaxed: 0.8, balanced: 0.6, strict: 0.4 };

// ---- Caches ----
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  delete(k: string) {
    this.m.delete(k);
  }
  set(k: string, v: V) {
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}
const textCache = new Lru<Promise<TextScores>>(3000);
const imageCache = new Lru<Promise<number>>(3000);

async function classify(post: PostData, settings: Settings): Promise<Verdict> {
  const t0 = performance.now();
  const scores: Verdict["scores"] = {};
  const c = settings.categories;
  const goals = settings.goals.filter((g) => g.trim());

  // Images (sexualised only) — run in parallel with the text model.
  const imagesP =
    c.sexualised && post.imageUrls.length
      ? Promise.all(
          post.imageUrls.slice(0, 4).map((u) => {
            let p = imageCache.get(u);
            if (!p) {
              p = imageScore(u).catch(() => 0);
              imageCache.set(u, p);
            }
            return p;
          }),
        ).then((xs) => Math.max(...xs))
      : Promise.resolve(undefined);

  const words = post.text.trim().split(/\s+/).filter(Boolean).length;
  let textDecision: { category: Category; score: number } | undefined;
  if (words > 0 && (c.sexualised || c.clickbait || c.politics || c.gossip || (c.offgoal && goals.length))) {
    const key = `${goals.join("\n")}\u0000${post.text}`;
    let p = textCache.get(key);
    if (!p) {
      p = getTextClassifier().then((clf) => clf.score(post.text, goals));
      textCache.set(key, p);
      p.catch(() => textCache.delete(key)); // don't cache failures
    }
    const s = await p;
    for (const [k, v] of Object.entries(s.margin)) scores[k as Category] = v;
    if (s.goalRelevance !== undefined) scores.offgoal = s.goalRelevance;
    // Too little text to judge relevance → don't hide as off-goal.
    const enabled = { ...c, offgoal: c.offgoal && words >= 3 };
    textDecision = decideText(s, enabled, settings.strictness);
  }

  const img = await imagesP;
  const ms = Math.round(performance.now() - t0);
  if (img !== undefined && img >= IMAGE_THRESHOLD[settings.strictness]) {
    scores.sexualised = Math.max(scores.sexualised ?? 0, img);
    return { hide: true, category: "sexualised", reason: "Suggestive image", scores, ms };
  }
  if (textDecision) {
    const reasons: Record<Category, string> = {
      sexualised: "Suggestive text",
      clickbait: "Clickbait / vaguepost",
      politics: "Politics",
      gossip: "Celebrity / gossip",
      offgoal: "Not related to your goals",
    };
    return { hide: true, category: textDecision.category, reason: reasons[textDecision.category], scores, ms };
  }
  return { hide: false, scores, ms };
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === "offscreen-classify") {
    classify(msg.post, msg.settings)
      .then(sendResponse)
      .catch((e) => sendResponse({ hide: false, scores: {}, ms: 0, error: String(e) }));
    return true;
  }
  if (msg.type === "warmup") {
    void getTextClassifier();
    void getNsfw();
  }
  return false;
});

// Start loading models as soon as the document opens.
void getTextClassifier();
void getNsfw();
