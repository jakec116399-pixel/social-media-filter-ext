// Measures text-classifier accuracy on tests/data/realistic-posts.json and
// tests/data/topic-posts.json (posts NOT used to write the example posts).
// Runs the same model and code as the extension, but in Node.
//   npm run eval                 -> summary per strictness level
//   npm run eval -- --mistakes   -> list topic/tone mistakes (balanced)
//   npm run eval -- --sweep      -> accuracy vs threshold, for calibration
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import { TextClassifier, decideText, topTopic, THRESHOLDS, type TextScores } from "../src/shared/textModel.ts";
import { heuristicHits } from "../src/shared/heuristics.ts";
import { TONE_IDS, TOPIC_IDS, type Category, type LabelId, type Strictness, type ToneId } from "../src/shared/types.ts";

const root = join(import.meta.dirname, "..");
env.allowRemoteModels = false;
env.localModelPath = join(root, "public", "models") + "/";

type Post = { text: string; topic: string; tones: ToneId[]; goal?: boolean };
// tests/data/private/real-feed.json (gitignored) holds posts from a real feed, if present.
const files = ["realistic-posts.json", "topic-posts.json", "private/real-feed.json"].filter((f) =>
  existsSync(join(root, "tests/data", f)),
);
const sets = files.map((f) => {
  const d = JSON.parse(readFileSync(join(root, "tests/data", f), "utf8"));
  return {
    name: f.replace(".json", ""),
    goals: d.goals as string[],
    posts: d.posts as Post[],
    hide: d.hide ? new Set<LabelId>(d.hide) : undefined,
  };
});
const only = process.argv.find((a) => a.startsWith("--set="))?.slice(6);

const MODEL = process.env.FF_MODEL || "Xenova/all-MiniLM-L6-v2";
const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
console.log(`Model: ${MODEL}`);
const clf = new TextClassifier(async (texts) => {
  const out = await extractor(texts, { pooling: (process.env.FF_POOLING as "mean" | "cls") || "mean", normalize: true });
  const dim = out.dims[1];
  const flat = out.data as Float32Array;
  return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
});
await clf.init();

const none = Object.fromEntries([...TOPIC_IDS, ...TONE_IDS, "offgoal"].map((k) => [k, false])) as Record<Category, boolean>;

/** All labels at this strictness: AI + keyword rules, as in the extension. */
function labelsFor(p: Post, s: TextScores, st: Strictness): Set<LabelId> {
  const out = new Set(decideText(s, none, st).labels);
  for (const h of heuristicHits({ text: p.text, hasLink: /https?:|\.com/.test(p.text), hasMedia: false })) out.add(h.category);
  if (out.has("explicit")) out.delete("suggestive"); // as in the extension
  return out;
}

// A typical user: hides explicit, suggestive, politics, gossip and the three bait/vague tones.
const HIDE = new Set<LabelId>(["explicit", "suggestive", "politics", "gossip", "ragebait", "engagementbait", "vaguepost"]);
let HIDE_NOW = HIDE;
const shouldHide = (p: Post) => HIDE_NOW.has(p.topic as LabelId) || p.tones.some((t) => HIDE_NOW.has(t));

const showMistakes = process.argv.includes("--mistakes");
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;

for (const set of sets) {
  if (only && !set.name.includes(only)) continue;
  HIDE_NOW = set.hide ?? HIDE;
  const scored: { p: Post; s: TextScores }[] = [];
  for (const p of set.posts) scored.push({ p, s: await clf.score(p.text, set.goals) });
  const withTopic = scored.filter((x) => x.p.topic !== "any");
  const top1 = withTopic.filter((x) => topTopic(x.s) === x.p.topic).length;
  console.log(`\n### ${set.name} (${set.posts.length} posts)`);
  console.log(`  closest topic correct: ${pct(top1, withTopic.length)}`);
  // Explicit vs suggestive specifically.
  const sex = scored.filter((x) => x.p.topic === "explicit" || x.p.topic === "suggestive");
  if (sex.length) {
    const exact = sex.filter((x) => labelsFor(x.p, x.s, "balanced").has(x.p.topic as LabelId)).length;
    const either = sex.filter((x) => { const L = labelsFor(x.p, x.s, "balanced"); return L.has("explicit") || L.has("suggestive"); }).length;
    console.log(`  sexual posts (balanced): caught as either ${pct(either, sex.length)}, exact label ${pct(exact, sex.length)}`);
  }
  if (showMistakes) {
    for (const x of withTopic) if (topTopic(x.s) !== x.p.topic) console.log(`     topic ${x.p.topic} → ${topTopic(x.s)}: ${x.p.text.slice(0, 80)}`);
  }

  for (const st of ["relaxed", "balanced", "strict"] as Strictness[]) {
    let topicHit = 0, topicWrong = 0, toneHit = 0, toneTotal = 0, toneFalse = 0;
    let caught = 0, unwanted = 0, falseHide = 0, wanted = 0;
    const mistakes: string[] = [];
    for (const { p, s } of scored) {
      const L = labelsFor(p, s, st);
      if (p.topic !== "any") {
        if (L.has(p.topic as LabelId)) topicHit++;
        const wrong = [...L].filter((l) => (TOPIC_IDS as string[]).includes(l) && l !== p.topic);
        if (wrong.length) { topicWrong++; mistakes.push(`     wrong topic ${wrong.join(",")} (expected ${p.topic}): ${p.text.slice(0, 70)}`); }
      }
      for (const t of TONE_IDS) {
        const expected = p.tones.includes(t);
        if (expected) { toneTotal++; if (L.has(t)) toneHit++; else mistakes.push(`     missed tone ${t}: ${p.text.slice(0, 70)}`); }
        else if (L.has(t)) { toneFalse++; mistakes.push(`     false tone ${t}: ${p.text.slice(0, 70)}`); }
      }
      const hidden = [...L].some((l) => HIDE_NOW.has(l));
      if (shouldHide(p)) { unwanted++; if (hidden) caught++; else mistakes.push(`     NOT HIDDEN: ${p.text.slice(0, 70)}`); }
      else { wanted++; if (hidden) { falseHide++; mistakes.push(`     WRONGLY HIDDEN by ${[...L].filter((l) => HIDE_NOW.has(l)).join(",")}: ${p.text.slice(0, 70)}`); } }
    }
    console.log(
      `  ${st.padEnd(8)} topic found ${pct(topicHit, withTopic.length)}, extra wrong topic on ${topicWrong} | ` +
        `tones found ${pct(toneHit, toneTotal)}, false tones ${toneFalse} | ` +
        `typical user: unwanted hidden ${pct(caught, unwanted)}, good posts hidden ${pct(falseHide, wanted)}`,
    );
    if (showMistakes && st === "balanced") console.log(mistakes.join("\n"));
  }

  // Off-goal mode.
  const goalPosts = scored.filter((x) => x.p.goal !== undefined);
  if (goalPosts.length) {
    for (const st of ["relaxed", "balanced", "strict"] as Strictness[]) {
      let ok = 0;
      for (const { p, s } of goalPosts) {
        const hidden = decideText(s, { ...none, offgoal: true }, st).hiddenBy.includes("offgoal");
        if (hidden === !p.goal) ok++;
      }
      console.log(`  off-goal ${st.padEnd(8)} ${pct(ok, goalPosts.length)}`);
    }
  }

  if (process.argv.includes("--sweep")) {
    console.log("  tone margin → tones found / false tones");
    for (let th = 0; th <= 0.16; th += 0.02) {
      let hit = 0, tot = 0, fa = 0;
      for (const { p, s } of scored) for (const t of TONE_IDS) {
        if (p.tones.includes(t)) { tot++; if (s.tone[t] >= th) hit++; } else if (s.tone[t] >= th) fa++;
      }
      console.log(`    ${th.toFixed(2)}  ${hit}/${tot}  ${fa}`);
    }
    console.log("  topic lead → expected topic found / extra wrong topics (floor 0.25)");
    for (let th = -0.04; th <= 0.06; th += 0.01) {
      let hit = 0, wrong = 0;
      for (const { p, s } of withTopic) for (const t of TOPIC_IDS) {
        const on = s.topic[t].lead >= th && s.topic[t].sim >= 0.25;
        if (t === p.topic && on) hit++;
        if (t !== p.topic && on) wrong++;
      }
      console.log(`    ${th.toFixed(2)}  ${hit}/${withTopic.length}  ${wrong}`);
    }
  }
}
console.log("\nBalanced thresholds:", JSON.stringify(THRESHOLDS.balanced));

if (process.argv.includes("--tones")) {
  // Per-tone calibration across both sets.
  const all: { p: Post; s: TextScores }[] = [];
  for (const set of sets) for (const p of set.posts) all.push({ p, s: await clf.score(p.text, set.goals) });
  for (const t of TONE_IDS) {
    const row = [];
    for (let th = 0.04; th <= 0.2; th += 0.02) {
      let hit = 0, tot = 0, fa = 0;
      for (const { p, s } of all) {
        if (p.tones.includes(t)) { tot++; if (s.tone[t] >= th) hit++; } else if (s.tone[t] >= th) fa++;
      }
      row.push(`${th.toFixed(2)}:${hit}/${tot},fa${fa}`);
    }
    console.log(`${t.padEnd(15)} ${row.join("  ")}`);
  }
}

if (process.argv.includes("--grid")) {
  // Topic confidence grid (balanced): how many unwanted posts are hidden vs good posts wrongly hidden.
  const all = [];
  for (const set of sets) {
    const scored = [];
    for (const p of set.posts) scored.push({ p, s: await clf.score(p.text, set.goals) });
    all.push({ set, scored });
  }
  const base = { ...THRESHOLDS.balanced };
  console.log("lead  floor | " + all.map((a) => a.set.name.padEnd(26)).join(" | "));
  for (const lead of [0, 0.01, 0.02, 0.03, 0.04]) {
    for (const floor of [0.22, 0.26, 0.3]) {
      Object.assign(THRESHOLDS.balanced, { ...base, topicLead: lead, topicFloor: floor });
      const cells = all.map(({ set, scored }) => {
        HIDE_NOW = set.hide ?? HIDE;
        let c = 0, u = 0, f = 0, w = 0;
        for (const { p, s } of scored) {
          const hidden = [...labelsFor(p, s, "balanced")].some((l) => HIDE_NOW.has(l));
          if (shouldHide(p)) { u++; if (hidden) c++; } else { w++; if (hidden) f++; }
        }
        return `caught ${c}/${u}, false ${f}/${w}`.padEnd(26);
      });
      console.log(`${lead.toFixed(2)}  ${floor.toFixed(2)}  | ${cells.join(" | ")}`);
    }
  }
  Object.assign(THRESHOLDS.balanced, base);
}
