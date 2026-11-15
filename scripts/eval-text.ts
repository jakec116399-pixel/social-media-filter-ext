// Measures text-filter accuracy on the labelled test sets in tests/data.
// Runs the same model and code as the extension, but in Node.
//   npm run eval                  -> report for every strictness level
//   npm run eval -- --mistakes    -> also list wrong decisions (balanced)
//   npm run eval -- --sweep       -> show how accuracy changes with the threshold
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import { TextClassifier, decideText, THRESHOLDS, type TextScores } from "../src/shared/textModel.ts";
import { heuristicHits } from "../src/shared/heuristics.ts";
import type { Category, Strictness } from "../src/shared/types.ts";

const root = join(import.meta.dirname, "..");
env.allowRemoteModels = false;
env.localModelPath = join(root, "public", "models") + "/";

type Post = { label: Category | "none"; text: string; goal?: boolean };
const sets = ["labeled-posts.json", "realistic-posts.json"].map((f) => {
  const d = JSON.parse(readFileSync(join(root, "tests/data", f), "utf8"));
  return { name: f.replace(".json", ""), goals: d.goals as string[], posts: d.posts as Post[] };
});

const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
const embed = async (texts: string[]) => {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1];
  const flat = out.data as Float32Array;
  return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
};
const clf = new TextClassifier(embed);
await clf.init();

const topicCats = ["sexualised", "clickbait", "politics", "gossip"] as const;
const allOn = { sexualised: true, clickbait: true, politics: true, gossip: true, offgoal: false };
const goalOnly = { sexualised: false, clickbait: false, politics: false, gossip: false, offgoal: true };

/** Same order as the extension: keywords first, then AI. */
function predict(p: Post, s: TextScores, strictness: Strictness): Category | "none" {
  const h = heuristicHits({ text: p.text, hasLink: /https?:|\.com/.test(p.text), hasMedia: false });
  if (h.length) return h[0].category;
  return decideText(s, allOn, strictness)?.category ?? "none";
}

const showMistakes = process.argv.includes("--mistakes");
for (const set of sets) {
  const t0 = performance.now();
  const scored: { p: Post; s: TextScores }[] = [];
  for (const p of set.posts) scored.push({ p, s: await clf.score(p.text, set.goals) });
  console.log(`\n### ${set.name} (${set.posts.length} posts, ${((performance.now() - t0) / set.posts.length).toFixed(1)} ms/post)`);

  for (const strictness of ["relaxed", "balanced", "strict"] as Strictness[]) {
    let hiddenRight = 0, hiddenWrongCat = 0, missed = 0, falseAlarm = 0, cleanOk = 0;
    const mistakes: string[] = [];
    for (const { p, s } of scored) {
      const pred = predict(p, s, strictness);
      if (p.label === "none") {
        if (pred === "none") cleanOk++;
        else { falseAlarm++; mistakes.push(`   FALSE ALARM (${pred}): ${p.text}`); }
      } else if (pred === p.label) hiddenRight++;
      else if (pred === "none") { missed++; mistakes.push(`   MISSED ${p.label}: ${p.text}`); }
      else { hiddenWrongCat++; mistakes.push(`   WRONG CATEGORY ${p.label} → ${pred}: ${p.text}`); }
    }
    const bad = scored.filter((x) => x.p.label !== "none").length;
    const good = scored.length - bad;
    // Off-goal on its own.
    let goalOk = 0, goalTotal = 0, onGoalHidden = 0;
    for (const { p, s } of scored) {
      if (p.label !== "none") continue;
      goalTotal++;
      const hidden = decideText(s, goalOnly, strictness)?.category === "offgoal";
      if (hidden === !p.goal) goalOk++;
      else if (hidden) onGoalHidden++;
    }
    console.log(
      `  ${strictness.padEnd(9)} unwanted caught ${hiddenRight + hiddenWrongCat}/${bad} ` +
        `(right category ${hiddenRight}, wrong category ${hiddenWrongCat}) | ` +
        `good posts wrongly hidden ${falseAlarm}/${good} | off-goal ${goalOk}/${goalTotal} (on-goal hidden ${onGoalHidden})`,
    );
    if (showMistakes && strictness === "balanced") console.log(mistakes.join("\n"));
  }

  if (process.argv.includes("--sweep")) {
    console.log("  margin  caught  falseAlarms   (AI only, all topic categories)");
    for (let th = -0.04; th <= 0.16; th += 0.02) {
      let caught = 0, fa = 0;
      for (const { p, s } of scored) {
        const hit = topicCats.some((c) => s.margin[c] >= th);
        if (p.label === "none") fa += hit ? 1 : 0;
        else caught += hit ? 1 : 0;
      }
      console.log(`  ${th.toFixed(2).padStart(6)}  ${String(caught).padStart(6)}  ${String(fa).padStart(11)}`);
    }
    console.log("  goal-threshold  on-goal-hidden  off-goal-shown");
    for (let th = 0.16; th <= 0.42; th += 0.02) {
      let a = 0, b = 0;
      for (const { p, s } of scored) {
        if (p.label !== "none") continue;
        const hid = (s.goalRelevance ?? 1) < th;
        if (p.goal && hid) a++;
        if (!p.goal && !hid) b++;
      }
      console.log(`  ${th.toFixed(2).padStart(14)}  ${String(a).padStart(14)}  ${String(b).padStart(14)}`);
    }
  }
}
console.log("\nThresholds:", JSON.stringify(THRESHOLDS.balanced));
