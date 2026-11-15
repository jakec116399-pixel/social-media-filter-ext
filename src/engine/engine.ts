// The AI engine. Runs in Chrome's offscreen document, or Firefox's background page.
//  - Text: all-MiniLM-L6-v2 sentence embeddings (ONNX, ~23 MB) for zero-shot topic scoring
//  - Images: NSFWJS MobileNetV2 (~3 MB) for sexualised-image detection
// The AI libraries are imported lazily so each lands in its own smaller file.
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { NSFWJS } from "nsfwjs/core";
import { ext } from "../shared/ext";
import { heuristicHits } from "../shared/heuristics";
import {
  TextClassifier,
  decideText,
  decodePrecomputed,
  type PrecomputedFile,
  type TextScores,
} from "../shared/textModel";
import {
  labelName,
  type Category,
  type LabelId,
  type PostData,
  type Settings,
  type Strictness,
  type UserExamples,
  type Verdict,
} from "../shared/types";

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
      // Example-post embeddings computed at build time; anything missing is computed here.
      const precomputed = await fetch(ext.runtime.getURL("prototype-vectors.json"))
        .then((r) => (r.ok ? r.json() : null))
        .then((f: PrecomputedFile | null) => (f ? decodePrecomputed(f) : undefined))
        .catch(() => undefined);
      const clf = new TextClassifier(async (texts) => {
        const out = await extractor(texts, { pooling: "mean", normalize: true });
        const dim = out.dims[1];
        const flat = out.data as Float32Array;
        return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
      }, precomputed);
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
  }
  const img = await imagesP;
  const ms = Math.round(performance.now() - t0);

  // Labels from the AI (topics + tones), keyword rules, and the image model.
  const enabled = { ...c, offgoal: c.offgoal && words >= 3 && goals.length > 0 };
  const decision = text ? decideText(text, enabled, settings.strictness) : { labels: [], hiddenBy: [] };
  const labels: LabelId[] = [...decision.labels];
  const keep = text?.taught?.action === "keep";
  if (!keep) {
    for (const h of heuristicHits(post)) if (!labels.includes(h.category)) labels.push(h.category);
    if (img !== undefined && img >= IMAGE_THRESHOLD[settings.strictness]) {
      // Suggestive image: sexualised becomes the leading label.
      if (labels.includes("sexualised")) labels.splice(labels.indexOf("sexualised"), 1);
      labels.unshift("sexualised");
    }
  }
  const hiddenBy: Category[] = keep ? [] : labels.filter((l) => c[l]);
  if (!keep && !hiddenBy.length && decision.hiddenBy.includes("offgoal")) hiddenBy.push("offgoal");

  if (text) {
    // Scores for the "why?" tooltip: top topics and any notable tones.
    const topics = Object.entries(text.topic)
      .sort((x, y) => y[1].sim - x[1].sim)
      .slice(0, 3);
    for (const [k, v] of topics) scores[k as Category] = round(v.sim);
    for (const [k, v] of Object.entries(text.tone)) if (v > 0) scores[k as Category] = round(v);
    if (text.goalRelevance !== undefined) scores.offgoal = round(text.goalRelevance);
  }
  if (img !== undefined) scores.image = round(img);

  const suggestiveImage = img !== undefined && img >= IMAGE_THRESHOLD[settings.strictness];
  const name = (h: Category) => (h === "sexualised" && suggestiveImage ? "Suggestive image" : labelName(h));
  const reason = hiddenBy.map(name).join(" · ") + (text?.taught?.action === "hide" ? " (you taught this)" : "");
  return {
    hide: hiddenBy.length > 0,
    labels,
    hiddenBy,
    category: hiddenBy[0],
    reason: keep ? "You taught: keep posts like this" : hiddenBy.length ? reason : undefined,
    scores,
    ms,
  };
}

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
