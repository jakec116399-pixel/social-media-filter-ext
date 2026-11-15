// Keyword / pattern checks that catch obvious cases with high precision.
// They add labels on top of what the AI model finds.
import type { LabelId, PostData } from "./types.ts";

type Rule = { category: LabelId; re: RegExp; reason: string };

const w = (words: string[]) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words.join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

const RULES: Rule[] = [
  {
    category: "explicit",
    reason: "Explicit / NSFW language",
    re: w([
      "onlyfans",
      "of link",
      "link in bio 🔞",
      "nsfw",
      "🔞",
      "nudes?",
      "nudity",
      "porn\\w*",
      "naked",
      "xxx",
      "fansly",
      "sext\\w*",
      "lewd",
      "uncensored (?:pics|photos|video|vid|set|version)",
      "18\\+ (?:only|content|account)",
      "minors dni",
      "hentai",
    ]),
  },
  {
    category: "suggestive",
    reason: "Suggestive language",
    re: w([
      "sexy",
      "horny",
      "thirst ?trap",
      "lingerie",
      "boobs?",
      "titties",
      "booty",
      "milf",
      "spicy (?:content|pics)",
      "dm (?:me )?for (?:more|pics)",
      "smash or pass",
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
    category: "engagementbait",
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
      "only \\d+% (?:of (?:people|you) )?(?:can|will|get|know)",
      "can you (?:find|spot|solve|see) (?:it|the|this)",
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
  category: LabelId;
  reason: string;
}

export function heuristicHits(post: Pick<PostData, "text" | "hasLink" | "hasMedia">): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const text = post.text.trim();
  for (const r of RULES) if (r.re.test(text)) hits.push({ category: r.category, reason: r.reason });

  // Suggestive emoji, optionally with adult-creator promo phrasing ("full set", "subscribers"...).
  const signal = suggestiveSignals(text);
  if (signal && !hits.some((h) => h.category === signal)) {
    hits.unshift({ category: signal, reason: signal === "explicit" ? "Adult content promo" : "Suggestive post" });
  }

  // Templated / trend-format posts (greentext, POV:, nobody: me:, ...).
  const fmt = trendFormat(post.text);
  if (fmt) hits.push({ category: "format", reason: fmt });

  // Vagueposts: very short, no link or media, and no concrete information.
  if (isVaguepost(post)) {
    hits.push({ category: "vaguepost", reason: "Vaguepost" });
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

/**
 * Suggestive emoji plus adult-creator promo phrasing → "explicit" (it's selling
 * NSFW content); two or more suggestive emoji on their own → "suggestive".
 */
export function suggestiveSignals(text: string): "explicit" | "suggestive" | undefined {
  const n = text.match(SUGGESTIVE_EMOJI)?.length ?? 0;
  if (n >= 1 && PROMO_RE.test(text)) return "explicit";
  if (n >= 2) return "suggestive";
  return undefined;
}

// Recognisable post templates. Checked on the raw text (line breaks matter).
const FORMATS: [RegExp, string][] = [
  [/(?:^|\n)[ \t]*>[ \t]*\S[^\n]*\n[ \t]*>[ \t]*\S/, "Greentext (> be me)"],
  [/(?:^|\n)[ \t]*pov ?:/i, "POV post"],
  [/(?:^|\n)[ \t]*nobody ?:/i, '"nobody: / me:" format'],
  [
    /(?:^|\n)[ \t]*me ?:[^\n]*\n+[ \t]*(?:also me|me \d+ (?:minutes?|hours?|seconds?) later|my (?:brain|bank account|wallet)|the \w+)[^\n]*:/i,
    '"me: / also me:" format',
  ],
  [
    /\btell me (?:you(?:'|’)?re|you are|you|your)\b.{1,60}\bwithout telling me\b/i,
    '"tell me without telling me" format',
  ],
  [/\bhow it started\b.{0,40}\bhow it(?:'|’)?s going\b/is, '"how it started / going" format'],
  [/\bexpectation(?:s)? (?:vs\.?|versus|x) reality\b/i, '"expectation vs reality" format'],
  [/\bstarter pack\b/i, "Starter pack"],
  [/\bname a (?:more iconic|better) (?:duo|trio|combo)\b/i, '"name a more iconic duo" format'],
  [/\bthings that just make sense\b/i, '"things that just make sense" format'],
  [/\bday \d+ (?:vs\.?|versus) day \d+\b/i, '"day 1 vs day 100" format'],
  [/(?:^|\n)[ \t]*(?:it(?:'|’)?s giving)\b/i, '"it\'s giving" format'],
];

/** Name of the trend format a post uses, if any. */
export function trendFormat(text: string): string | undefined {
  for (const [re, name] of FORMATS) if (re.test(text)) return name;
  return undefined;
}
