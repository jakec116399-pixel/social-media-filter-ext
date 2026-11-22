// Trains the topic classifier "head": a small one-vs-rest logistic regression on
// top of the sentence embeddings the extension already computes.
//
// Data: TweetTopic (Cardiff NLP, real tweets labelled with 19 topics), downloaded
// to training/data/ (gitignored). Licence is listed as "other" (research data):
// fine for prototyping and measurement; confirm terms (or retrain on licence-clean
// data with this same script) before commercial release.
//
//   node --experimental-strip-types training/train-head.ts            # train + report
//   FF_MODEL=Xenova/bge-small-en-v1.5 FF_POOLING=cls node ...           # other embedding model
//
// Output: training/out/topic-head.json (weights only, ~40 KB). Not shipped: on a
// real feed this head named topics better (62% vs 54%) but did not improve what
// gets hidden, because TweetTopic's labels mean something different from ours
// (e.g. "celebrity & pop culture" = any famous person, not gossip) and it has no
// tones. The same pipeline is meant for training data written to our own
// definitions. To try a head in evaluation: FF_HEAD=path npm run eval.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import { cleanText } from "../src/shared/textModel.ts";
import { HEAD_CLASSES, type HeadClass, type TopicHead } from "../src/shared/head.ts";

const root = join(import.meta.dirname, "..");
const dataDir = join(root, "training", "data");
env.allowRemoteModels = false;
env.localModelPath = join(root, "public", "models") + "/";
const MODEL = process.env.FF_MODEL || "Xenova/all-MiniLM-L6-v2";
const POOLING = (process.env.FF_POOLING as "mean" | "cls") || "mean";

// TweetTopic's 19 labels → our classifier classes.
const TT = [
  "arts_&_culture", "business_&_entrepreneurs", "celebrity_&_pop_culture", "diaries_&_daily_life", "family",
  "fashion_&_style", "film_tv_&_video", "fitness_&_health", "food_&_dining", "gaming", "learning_&_educational",
  "music", "news_&_social_concern", "other_hobbies", "relationships", "science_&_technology", "sports",
  "travel_&_adventure", "youth_&_student_life",
];
const MAP: Record<string, HeadClass> = {
  "arts_&_culture": "entertainment", "film_tv_&_video": "entertainment", gaming: "entertainment", music: "entertainment",
  "business_&_entrepreneurs": "business",
  "celebrity_&_pop_culture": "gossip",
  "diaries_&_daily_life": "personal", family: "personal", "youth_&_student_life": "personal",
  "fashion_&_style": "lifestyle", "food_&_dining": "lifestyle", other_hobbies: "lifestyle", "travel_&_adventure": "lifestyle",
  "fitness_&_health": "fitness",
  "learning_&_educational": "learning",
  "news_&_social_concern": "newsSocial",
  relationships: "relationships",
  "science_&_technology": "tech",
  sports: "sports",
};

type Row = { text: string; labels: number[] };
/** TweetTopic marks verified accounts as {@Name@} and users/links as {{USERNAME}}/{{URL}}. */
const prep = (t: string) => cleanText(t.replace(/\{@([^@]*)@\}/g, "$1").replace(/\{\{(?:USERNAME|URL)\}\}/g, " "));

function load(name: string): { x: string[]; y: number[][] } {
  const rows: Row[] = JSON.parse(readFileSync(join(dataDir, `${name}.json`), "utf8"));
  const x: string[] = [];
  const y: number[][] = [];
  for (const r of rows) {
    const target = HEAD_CLASSES.map(() => 0);
    r.labels.forEach((on, i) => {
      if (on) target[HEAD_CLASSES.indexOf(MAP[TT[i]])] = 1;
    });
    x.push(prep(r.text));
    y.push(target);
  }
  return { x, y };
}

const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
async function embedAll(texts: string[], cacheName: string): Promise<Float32Array[]> {
  const cache = join(dataDir, `${cacheName}.${MODEL.replace(/\W/g, "_")}.${POOLING}.bin`);
  const dim = (await extractor(["x"], { pooling: POOLING, normalize: true })).dims[1];
  if (existsSync(cache)) {
    const all = new Float32Array(readFileSync(cache).buffer.slice(0));
    if (all.length === texts.length * dim) return texts.map((_, i) => all.slice(i * dim, (i + 1) * dim));
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const e = await extractor(batch, { pooling: POOLING, normalize: true });
    const flat = e.data as Float32Array;
    batch.forEach((_, j) => out.push(flat.slice(j * dim, (j + 1) * dim)));
  }
  const all = new Float32Array(out.length * dim);
  out.forEach((v, i) => all.set(v, i * dim));
  writeFileSync(cache, Buffer.from(all.buffer));
  return out;
}

const train = load("train_all");
const val = load("validation_2021");
const test = load("test_2021");
console.log(`Embedding ${train.x.length + val.x.length + test.x.length} tweets with ${MODEL} (${POOLING})...`);
const Xtr = await embedAll(train.x, "train_all");
const Xva = await embedAll(val.x, "validation_2021");
const Xte = await embedAll(test.x, "test_2021");
const D = Xtr[0].length;
const K = HEAD_CLASSES.length;

// ---- One-vs-rest logistic regression, full-batch Adam with L2 ----
const EPOCHS = Number(process.env.FF_EPOCHS ?? 120);
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
function trainHead(X: Float32Array[], Y: number[][], l2: number, epochs: number) {
  const W = Array.from({ length: K }, () => new Float64Array(D));
  const b = new Float64Array(K);
  // Weight positives so rare classes still matter.
  const pos = HEAD_CLASSES.map((_, k) => Y.reduce((s, y) => s + y[k], 0));
  const posW = pos.map((p) => Math.min(10, (X.length - p) / Math.max(1, p)) ** 0.5);
  const mW = W.map(() => new Float64Array(D)), vW = W.map(() => new Float64Array(D));
  const mb = new Float64Array(K), vb = new Float64Array(K);
  const lr = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let ep = 1; ep <= epochs; ep++) {
    for (let k = 0; k < K; k++) {
      const gW = new Float64Array(D);
      let gb = 0;
      const w = W[k];
      for (let n = 0; n < X.length; n++) {
        const x = X[n];
        let z = b[k];
        for (let d = 0; d < D; d++) z += w[d] * x[d];
        const t = Y[n][k];
        const err = (sigmoid(z) - t) * (t ? posW[k] : 1);
        for (let d = 0; d < D; d++) gW[d] += err * x[d];
        gb += err;
      }
      for (let d = 0; d < D; d++) {
        const g = gW[d] / X.length + l2 * w[d];
        mW[k][d] = b1 * mW[k][d] + (1 - b1) * g;
        vW[k][d] = b2 * vW[k][d] + (1 - b2) * g * g;
        w[d] -= (lr * (mW[k][d] / (1 - b1 ** ep))) / (Math.sqrt(vW[k][d] / (1 - b2 ** ep)) + eps);
      }
      const g = gb / X.length;
      mb[k] = b1 * mb[k] + (1 - b1) * g;
      vb[k] = b2 * vb[k] + (1 - b2) * g * g;
      b[k] -= (lr * (mb[k] / (1 - b1 ** ep))) / (Math.sqrt(vb[k] / (1 - b2 ** ep)) + eps);
    }
  }
  return { W, b };
}

function predict(h: { W: Float64Array[]; b: Float64Array }, x: Float32Array): number[] {
  return h.W.map((w, k) => {
    let z = h.b[k];
    for (let d = 0; d < D; d++) z += w[d] * x[d];
    return sigmoid(z);
  });
}

function report(name: string, h: ReturnType<typeof trainHead>, X: Float32Array[], Y: number[][]) {
  let top1 = 0;
  const tp = new Array(K).fill(0), fp = new Array(K).fill(0), fn = new Array(K).fill(0);
  X.forEach((x, n) => {
    const p = predict(h, x);
    const best = p.indexOf(Math.max(...p));
    if (Y[n][best]) top1++;
    p.forEach((pk, k) => {
      const on = pk >= 0.5;
      if (on && Y[n][k]) tp[k]++;
      else if (on) fp[k]++;
      else if (Y[n][k]) fn[k]++;
    });
  });
  const f1 = HEAD_CLASSES.map((_, k) => (2 * tp[k]) / Math.max(1, 2 * tp[k] + fp[k] + fn[k]));
  const macro = f1.reduce((a, b) => a + b, 0) / K;
  console.log(`  ${name}: top-1 correct ${((100 * top1) / X.length).toFixed(1)}%, macro-F1 ${macro.toFixed(3)}`);
  return { top1: top1 / X.length, macro, f1 };
}

// Pick L2 on validation, then report once on the held-out test set.
let best = { l2: 0, macro: -1 };
for (const l2 of (process.env.FF_L2 ?? "1e-4,1e-3,3e-3").split(",").map(Number)) {
  const h = trainHead(Xtr, train.y, l2, EPOCHS);
  console.log(`L2 ${l2}`);
  const r = report("validation", h, Xva, val.y);
  if (r.macro > best.macro) best = { l2, macro: r.macro };
}
console.log(`\nFinal: L2 ${best.l2}, trained on train + validation`);
const head = trainHead([...Xtr, ...Xva], [...train.y, ...val.y], best.l2, EPOCHS);
const r = report("TEST (held out)", head, Xte, test.y);
HEAD_CLASSES.forEach((c, k) => console.log(`    ${c.padEnd(14)} F1 ${r.f1[k].toFixed(2)}`));

const out: TopicHead = {
  model: MODEL,
  pooling: POOLING,
  classes: [...HEAD_CLASSES],
  W: head.W.map((w) => Array.from(w, (v) => Math.round(v * 1e4) / 1e4)),
  b: Array.from(head.b, (v) => Math.round(v * 1e4) / 1e4),
  source: "TweetTopic (cardiffnlp/tweet_topic_multi), train_all + validation_2021",
};
const outPath = process.env.FF_HEAD_OUT || join(root, "training", "out", "topic-head.json");
writeFileSync(outPath, JSON.stringify(out));
console.log(`\nWrote ${outPath}`);
