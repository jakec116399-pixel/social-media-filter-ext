import { test } from "node:test";
import assert from "node:assert/strict";
import { containsSlur } from "../../src/shared/hate.ts";
import { heuristicHits } from "../../src/shared/heuristics.ts";

// Slurs are built from ROT13 here too, so the test file doesn't spell them out.
const r = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const N = r("avttn"), NR = r("avttre"), F = r("snttbg"), RT = r("ergneq");

test("catches slurs, including disguised ones", () => {
  for (const t of [
    `This ${N} is trying to ratio its creators`,
    `GTA is ${NR} coded`,
    `a flag saying "${NR.replace("i", "*").toUpperCase()}s"`, // N*GGERS
    `${N.replace("i", "1")} please`, // leetspeak
    `${F.replace("a", "@")}`, // f@ggot
    `you ${RT}`,
    // Cyrillic look-alike letters (а = U+0430)
    `${N.replace("a", "а")} what`,
  ]) {
    assert.ok(containsSlur(t), t);
  }
});

test("doesn't fire on lookalike words", () => {
  for (const t of [
    "Don't snigger at me",
    "Flights to Niger are cheap",
    "A raccoon got into the bin",
    "Gypsy Crusader went live again",
    "Nipped out for a fag and a coffee", // UK: cigarette
    "The cocoon hatched",
    "Scunthorpe United won 2-0",
    "That libtard comment was dumb", // political insult, handled as politics
    "spicy food",
  ]) {
    assert.equal(containsSlur(t), false, t);
  }
});

test("slur posts get the hate label", () => {
  assert.ok(heuristicHits({ text: `GTA is ${NR} coded`, hasLink: false, hasMedia: false }).some((h) => h.category === "hate"));
});
