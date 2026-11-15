// Tier 1: instant keyword / pattern checks. These run in the content script
// before any AI model, and catch the obvious cases with high precision.
import type { Category, PostData } from "./types";

type Rule = { category: Category; re: RegExp; reason: string };

const w = (words: string[]) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words.join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

const RULES: Rule[] = [
  {
    category: "sexualised",
    reason: "Explicit language",
    re: w([
      "onlyfans",
      "of link",
      "link in bio 🔞",
      "nsfw",
      "🔞",
      "nudes?",
      "porn\\w*",
      "sexy",
      "horny",
      "thirst ?trap",
      "lingerie",
      "boobs?",
      "titties",
      "booty",
      "naked",
      "xxx",
      "spicy (?:content|pics)",
      "dm (?:me )?for (?:more|pics)",
      "fansly",
      "milf",
      "sext\\w*",
      "lewd",
      "too (?:hot|spicy|naughty) for (?:here|this app|twitter|x)",
    ]),
  },
  {
    category: "politics",
    reason: "Political keywords",
    re: w([
      "trump",
      "biden",
      "harris",
      "obama",
      "maga",
      "democrats?",
      "republicans?",
      "gop",
      "dnc",
      "rnc",
      "liberals?",
      "conservatives?",
      "leftists?",
      "right[- ]wing",
      "left[- ]wing",
      "congress",
      "senate",
      "senators?",
      "parliament",
      "election",
      "electoral",
      "ballots?",
      "voters?",
      "midterms?",
      "white house",
      "prime minister",
      "tories",
      "labour party",
      "starmer",
      "farage",
      "woke",
      "impeach\\w*",
      "supreme court",
      "immigration",
      "border crisis",
      "abortion",
      "gun control",
      "netanyahu",
      "putin",
      "zelensky",
      "vance",
      "desantis",
      "aoc",
      "pelosi",
      "schumer",
      "mcconnell",
      "potus",
    ]),
  },
  {
    category: "gossip",
    reason: "Celebrity gossip",
    re: w([
      "kardashians?",
      "kanye",
      "taylor swift",
      "swifties",
      "beyonc[eé]",
      "drake",
      "kendrick",
      "diddy",
      "bieber",
      "selena gomez",
      "ariana grande",
      "met gala",
      "red carpet",
      "dating rumou?rs?",
      "split from",
      "breakup",
      "broke up",
      "cheating scandal",
      "baby daddy",
      "spotted together",
      "shades? (?:at|on)",
      "throws shade",
      "celebrity",
      "celebs?",
      "a-lister",
      "influencer drama",
      "tea ☕",
      "spill(?:ing)? the tea",
      "love island",
      "bachelor(?:ette)?",
      "tmz",
    ]),
  },
  {
    category: "clickbait",
    reason: "Engagement bait",
    re: w([
      "you won['’]?t believe",
      "nobody is talking about",
      "no one is talking about",
      "what happens next",
      "this changes everything",
      "they don['’]?t want you to know",
      "wait (?:for|till) the end",
      "will shock you",
      "i['’]?m speechless",
      "this is insane",
      "it['’]?s over for",
      "let that sink in",
      "read that again",
      "like (?:and|&) (?:retweet|rt)",
      "rt if",
      "retweet if",
      "follow for (?:more|part \\d)",
      "comment ['\"]?\\w+['\"]? (?:and|&) i['’]?ll",
      "drop a .{1,3} if",
      "(?:most|99%) (?:people|of you) (?:won['’]?t|can['’]?t|don['’]?t)",
      "only geniuses",
      "unpopular opinion",
      "we need to talk",
      "some of you",
      "y['’]?all aren['’]?t ready",
      "the audacity",
      "this ain['’]?t it",
      "you need to see this",
      "must watch",
      "gone wrong",
      "(?:is|are) cooked",
      "breaking:?\\s*🚨",
      "🚨🚨",
    ]),
  },
];

export interface HeuristicHit {
  category: Category;
  reason: string;
}

export function heuristicHits(post: Pick<PostData, "text" | "hasLink" | "hasMedia">): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const text = post.text.trim();
  for (const r of RULES) if (r.re.test(text)) hits.push({ category: r.category, reason: r.reason });

  // Suggestive emoji plus creator-promo phrasing ("full set", "link in bio"...).
  if (!hits.some((h) => h.category === "sexualised") && suggestiveSignals(text)) {
    hits.unshift({ category: "sexualised", reason: "Suggestive post" });
  }

  // Vagueposts: very short, no link or media, and no concrete information.
  if (!hits.some((h) => h.category === "clickbait") && isVaguepost(post)) {
    hits.push({ category: "clickbait", reason: "Vaguepost" });
  }
  return hits;
}

const VAGUE_RE =
  /^(?:wow|omg|lol|lmao+|bruh|smh|ugh|yikes|damn|wild|insane|crazy|big news|it['’]?s happening|here we go|so true|this\.?|same|mood|real|facts|ok(?:ay)?|hm+|interesting|welp|well then|oh no|not again|i[’']?m tired|soon|guess what|you know who you are|some people|certain people|must be nice)\b/i;

export function isVaguepost(post: Pick<PostData, "text" | "hasLink" | "hasMedia">): boolean {
  if (post.hasLink) return false;
  const words = post.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false; // media-only posts are judged by image models
  if (words.length > 12) return false;
  const letters = post.text.replace(/[^\p{L}]/gu, "").length;
  if (letters < 3) return true; // just emoji / punctuation
  return VAGUE_RE.test(post.text.trim()) && words.length <= 5;
}

const SUGGESTIVE_EMOJI = /😈|🍑|💦|🥵|😏|🔞|👅|🍆|🫦/gu;
const PROMO_RE =
  /\b(?:full (?:set|vid(?:eo)?)|unedited|uncensored|link in (?:my )?bio|on my (?:page|other account)|my (?:dms?|page)|subscribers?|exclusive content|private (?:pics|photos|content))\b/i;

/** Two or more suggestive emoji, or one alongside creator-promo phrasing. */
export function suggestiveSignals(text: string): boolean {
  const n = text.match(SUGGESTIVE_EMOJI)?.length ?? 0;
  return n >= 2 || (n >= 1 && PROMO_RE.test(text));
}
