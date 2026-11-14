// Measures text-filter accuracy on tests/data/labeled-posts.json.
// Runs the same model and code as the extension, but in Node.
//   npm run eval            -> report for every strictness level
//   npm run eval -- --sweep -> also print score distributions for calibration
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import { TextClassifier, decideText, type TextScores } from "../src/shared/textModel.ts";
import { heuristicHits } from "../src/shared/heuristics.ts";
import type { Category, Strictness } from "../src/shared/types.ts";

const root = join(import.meta.dirname, "..");
env.allowRemoteModels = false;
env.localModelPath = join(root, "public", "models") + "/";

const data = JSON.parse(readFileSync(join(root, "tests/data/labeled-posts.json"), "utf8"));
const goals: string[] = data.goals;
const posts: { label: Category | "none"; text: string; goal?: boolean }[] = data.posts;

const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
const embed = async (texts: string[]) => {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1];
  const flat = out.data as Float32Array;
  return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
};
const clf = new TextClassifier(embed);
await clf.init();

const t0 = performance.now();
const scored: { p: (typeof posts)[number]; s: TextScores }[] = [];
for (const p of posts) scored.push({ p, s: await clf.score(p.text, goals) });
const msPer = (performance.now() - t0) / posts.length;

const topicCats: Category[] = ["sexualised", "clickbait", "politics", "gossip"];
const allOn = { sexualised: true, clickbait: true, politics: true, gossip: true, offgoal: false } as Record<Category, boolean>;

function predict(p: (typeof posts)[number], s: TextScores, strictness: Strictness, useHeuristics: boolean): Category | "none" {
  if (useHeuristics) {
    const h = heuristicHits({ text: p.text, hasLink: false, hasMedia: false });
    if (h.length) return h[0].category;
  }
  return decideText(s, allOn, strictness)?.category ?? "none";
}

console.log(`\nText model: ${msPer.toFixed(1)} ms per post (Node, CPU)\n`);
for (const strictness of ["relaxed", "balanced", "strict"] as Strictness[]) {
  for (const useHeuristics of [false, true]) {
    let correct = 0;
    const per: Record<string, { tp: number; fp: number; fn: number }> = {};
    for (const c of [...topicCats, "none"]) per[c] = { tp: 0, fp: 0, fn: 0 };
    const mistakes: string[] = [];
    for (const { p, s } of scored) {
      const pred = predict(p, s, strictness, useHeuristics);
      if (pred === p.label) { correct++; per[p.label].tp++; }
      else {
        per[pred].fp++; per[p.label].fn++;
        mistakes.push(`   expected ${p.label.padEnd(10)} got ${pred.padEnd(10)} "${p.text}"`);
      }
    }
    console.log(`== ${strictness}${useHeuristics ? " + keywords" : " (AI only)"}: ${correct}/${posts.length} correct (${((100 * correct) / posts.length).toFixed(0)}%)`);
    for (const c of topicCats) {
      const { tp, fp, fn } = per[c];
      console.log(`   ${c.padEnd(11)} caught ${tp}/${tp + fn}, wrongly flagged ${fp}`);
    }
    if (process.argv.includes("--mistakes") && useHeuristics) console.log(mistakes.join("\n"));
  }
  // Off-goal mode on its own: is each post relevant to the goals?
  let ok = 0, total = 0, fp = 0, fn = 0;
  for (const { p, s } of scored) {
    if (p.label !== "none") continue;
    total++;
    const hidden = decideText(s, { ...allOn, sexualised: false, clickbait: false, politics: false, gossip: false, offgoal: true }, strictness)?.category === "offgoal";
    if (hidden === !p.goal) ok++;
    else if (hidden) fp++;
    else fn++;
  }
  console.log(`   off-goal    ${ok}/${total} correct (on-goal posts wrongly hidden: ${fp}, off-goal posts let through: ${fn})\n`);
}

if (process.argv.includes("--sweep")) {
  for (const { p, s } of scored) {
    const m = topicCats.map((c) => `${c.slice(0, 4)} ${s.margin[c as "politics"].toFixed(2)}/${s.sim[c as "politics"].toFixed(2)}`).join("  ");
    console.log(`${p.label.padEnd(10)} goal=${(s.goalRelevance ?? 0).toFixed(2)} ${p.goal ? "G" : " "} ${m}  ${p.text.slice(0, 50)}`);
  }
}
