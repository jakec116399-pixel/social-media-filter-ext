// The AI engine. Runs in Chrome's offscreen document, or Firefox's background page.
//  - Text: all-MiniLM-L6-v2 sentence embeddings (ONNX, ~23 MB) for zero-shot topic scoring
//  - Images: NSFWJS MobileNetV2 (~3 MB) for sexualised-image detection
// The AI libraries are imported lazily so each lands in its own smaller file.
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { NSFWJS } from "nsfwjs/core";
import { ext } from "../shared/ext";
import { heuristicHits } from "../shared/heuristics";
import { TextClassifier, decideText, type TextScores } from "../shared/textModel";
import type { Category, PostData, Settings, Strictness, TopicCategory, UserExamples, Verdict } from "../shared/types";

// ---- Text model ----
let textClf: Promise<TextClassifier> | null = null;
function getTextClassifier(): Promise<TextClassifier> {
  textClf ??= (async () => {
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = ext.runtime.getURL("models/");
      env.useBrowserCache = false;
      env.useWasmCache = false;
      const onnx = env.backends.onnx as { wasm: { wasmPaths: unknown; numThreads: number } };
      onnx.wasm.wasmPaths = {
        mjs: ext.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.mjs"),
        wasm: ext.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm"),
      };
      onnx.wasm.numThreads = 1;
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
    const [tf, { load: loadNsfw }, { MobileNetV2Model }] = await Promise.all([
      import("@tensorflow/tfjs"),
      import("nsfwjs/core"),
      import("nsfwjs/models/mobilenet_v2"),
    ]);
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

export async function classify(post: PostData, settings: Settings, examples: UserExamples): Promise<Verdict> {
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
  let text: TextScores | undefined;
  if (words > 0) {
    const clf = await getTextClassifier();
    await clf.setUserExamples(examples);
    const key = `${clf.examplesVersion.length}:${hashString(clf.examplesVersion)}\u0000${goals.join("\n")}\u0000${post.text}`;
    let p = textCache.get(key);
    if (!p) {
      p = clf.score(post.text, goals);
      textCache.set(key, p);
      p.catch(() => textCache.delete(key)); // don't cache failures
    }
    text = await p;
    for (const [k, v] of Object.entries(text.margin)) scores[k as Category] = round(v);
    if (text.goalRelevance !== undefined) scores.offgoal = round(text.goalRelevance);
  }

  const img = await imagesP;
  const ms = Math.round(performance.now() - t0);
  if (text?.taught?.action === "keep") return { hide: false, reason: "You taught: keep posts like this", scores, ms };

  if (img !== undefined) scores.image = round(img);
  if (img !== undefined && img >= IMAGE_THRESHOLD[settings.strictness]) {
    return { hide: true, category: "sexualised", reason: "Suggestive image", scores, ms };
  }
  if (text?.taught?.action === "hide" && c[text.taught.category]) {
    return {
      hide: true,
      category: text.taught.category,
      reason: `${REASONS[text.taught.category]} (you taught this)`,
      scores,
      ms,
    };
  }

  // Keyword rules: instant, high-precision. If the AI is clearly more confident
  // about a different enabled category, use that category instead.
  const hit = heuristicHits(post).find((h) => c[h.category]);
  const ai = text
    ? decideText(text, { ...c, offgoal: c.offgoal && words >= 3 && goals.length > 0 }, settings.strictness)
    : undefined;
  if (hit) {
    const kwMargin = text?.margin[hit.category as TopicCategory] ?? 0;
    if (ai && ai.category !== "offgoal" && ai.category !== hit.category && ai.score > kwMargin + 0.05) {
      return { hide: true, category: ai.category, reason: REASONS[ai.category], scores, ms };
    }
    return { hide: true, category: hit.category, reason: `${REASONS[hit.category]} (keywords)`, scores, ms };
  }
  if (ai) return { hide: true, category: ai.category, reason: REASONS[ai.category], scores, ms };
  return { hide: false, scores, ms };
}

const REASONS: Record<Category, string> = {
  sexualised: "Suggestive",
  clickbait: "Clickbait / vaguepost",
  politics: "Politics",
  gossip: "Celebrity / gossip",
  offgoal: "Not related to your goals",
};

const round = (x: number) => Math.round(x * 100) / 100;

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

/** Start loading both models so the first posts are judged quickly. */
export function warmup(): void {
  void getTextClassifier();
  void getNsfw();
}
