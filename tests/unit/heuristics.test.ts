import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicHits, isVaguepost } from "../../src/shared/heuristics.ts";
import { goalTexts, decideText } from "../../src/shared/textModel.ts";

const post = (text: string, extra = {}) => ({ text, hasLink: false, hasMedia: false, ...extra });
const cats = (text: string) => heuristicHits(post(text)).map((h) => h.category);

test("keyword rules catch obvious cases", () => {
  assert.deepEqual(cats("New OnlyFans drop tonight"), ["sexualised"]);
  assert.deepEqual(cats("The Senate vote on the election bill"), ["politics"]);
  assert.deepEqual(cats("Kanye just did it again"), ["gossip"]);
  assert.deepEqual(cats("You won't believe what happened next"), ["clickbait"]);
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

test("decideText respects enabled categories and thresholds", () => {
  const s = {
    margin: { sexualised: 0, clickbait: 0, politics: 0.3, gossip: 0 },
    sim: { sexualised: 0.1, clickbait: 0.1, politics: 0.5, gossip: 0.1 },
    goalRelevance: 0.05,
  };
  const on = { sexualised: true, clickbait: true, politics: true, gossip: true, offgoal: true };
  assert.equal(decideText(s, on, "balanced")?.category, "politics");
  assert.equal(decideText(s, { ...on, politics: false }, "balanced")?.category, "offgoal");
  assert.equal(decideText(s, { ...on, politics: false, offgoal: false }, "balanced"), undefined);
});
