import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicHits, isVaguepost } from "../../src/shared/heuristics.ts";
import { goalTexts, decideText, cleanText, type TextScores } from "../../src/shared/textModel.ts";
import { normalizeSettings } from "../../src/shared/settings.ts";
import { TONE_IDS, TOPIC_IDS, type Category, type ToneId, type TopicId } from "../../src/shared/types.ts";

const post = (text: string, extra = {}) => ({ text, hasLink: false, hasMedia: false, ...extra });
const cats = (text: string) => heuristicHits(post(text)).map((h) => h.category);

test("keyword rules catch obvious cases", () => {
  assert.deepEqual(cats("New OnlyFans drop tonight"), ["sexualised"]);
  assert.deepEqual(cats("The Senate vote on the election bill"), ["politics"]);
  assert.deepEqual(cats("Kanye just did it again"), ["gossip"]);
  assert.deepEqual(cats("You won't believe what happened next"), ["engagementbait"]);
});

test("keyword rules don't fire on ordinary posts", () => {
  for (const t of [
    "What a match! That last-minute goal was unbelievable",
    "Fixed the aspect ratio bug in our image viewer",
    "Who has a good sourdough recipe?",
    "Finally shipped v2 of our app",
  ]) {
    assert.deepEqual(cats(t), [], t);
  }
});

test("vagueposts", () => {
  assert.equal(isVaguepost(post("wow.")), true);
  assert.equal(isVaguepost(post("😳😳")), true);
  assert.equal(isVaguepost(post("wow", { hasLink: true })), false);
  assert.equal(isVaguepost(post("Wow, the new release cut our build times in half")), false);
});

test("preset goals expand to example posts", () => {
  assert.ok(goalTexts("Learning to code").length > 5);
  assert.ok(goalTexts("I want to get into programming").length > 5, "alias match");
  assert.equal(goalTexts("pottery").length, 3, "custom goals use generic phrasings");
});

function scores(topicSims: Partial<Record<TopicId, number>>, tone: Partial<Record<ToneId, number>> = {}, goal?: number): TextScores {
  const sims = Object.fromEntries(TOPIC_IDS.map((t) => [t, topicSims[t] ?? 0.1])) as Record<TopicId, number>;
  const topic = Object.fromEntries(
    TOPIC_IDS.map((t) => [t, { sim: sims[t], lead: sims[t] - Math.max(...TOPIC_IDS.filter((o) => o !== t).map((o) => sims[o])) }]),
  ) as TextScores["topic"];
  return { topic, tone: Object.fromEntries(TONE_IDS.map((t) => [t, tone[t] ?? -0.1])) as TextScores["tone"], goalRelevance: goal };
}
const off = Object.fromEntries([...TOPIC_IDS, ...TONE_IDS, "offgoal"].map((k) => [k, false])) as Record<Category, boolean>;

test("a post gets its top topic and any strong tones; only enabled labels hide it", () => {
  const s = scores({ politics: 0.5, news: 0.4 }, { ragebait: 0.2 });
  const d = decideText(s, { ...off, ragebait: true }, "balanced");
  assert.deepEqual(new Set(d.labels), new Set(["politics", "ragebait"]));
  assert.deepEqual(d.hiddenBy, ["ragebait"]);
  assert.deepEqual(decideText(s, off, "balanced").hiddenBy, [], "nothing enabled → shown");
});

test("a topic that isn't the closest doesn't count", () => {
  const s = scores({ sports: 0.5, gossip: 0.42 });
  assert.equal(decideText(s, { ...off, gossip: true }, "balanced").hiddenBy.length, 0);
});

test("sexualised needs a clear lead over other topics", () => {
  const close = scores({ sexualised: 0.42, lifestyle: 0.41 });
  assert.equal(decideText(close, { ...off, sexualised: true }, "balanced").hiddenBy.length, 0);
  const clear = scores({ sexualised: 0.55, lifestyle: 0.4 });
  assert.deepEqual(decideText(clear, { ...off, sexualised: true }, "balanced").hiddenBy, ["sexualised"]);
});

test("off-goal applies only when no other label hides the post", () => {
  const s = scores({ sports: 0.5 }, {}, 0.05);
  assert.deepEqual(decideText(s, { ...off, offgoal: true }, "balanced").hiddenBy, ["offgoal"]);
  assert.deepEqual(decideText(s, { ...off, offgoal: true, sports: true }, "balanced").hiddenBy, ["sports"]);
});

test("taught examples override the model", () => {
  const s = { ...scores({ politics: 0.5 }), taught: { action: "keep" as const } };
  assert.deepEqual(decideText(s, { ...off, politics: true }, "balanced").hiddenBy, []);
});

test("old settings migrate: clickbait becomes the three bait tones", () => {
  const s = normalizeSettings({ categories: { clickbait: true, politics: true } as never });
  assert.equal(s.categories.ragebait, true);
  assert.equal(s.categories.engagementbait, true);
  assert.equal(s.categories.vaguepost, true);
  assert.equal(s.categories.politics, true);
  assert.equal("clickbait" in s.categories, false);
});

test("cleanText strips links, mentions and hashtag symbols", () => {
  assert.equal(cleanText("@bob look https://t.co/x #BigNews nytimes.com/a"), "look Big News");
});

test("engagement-bait puzzles", () => {
  assert.deepEqual(cats("Only 2% of people can find the mistake in this picture. Can you?"), ["engagementbait"]);
  assert.deepEqual(cats("Can you spot the cat in this photo?"), ["engagementbait"]);
});
