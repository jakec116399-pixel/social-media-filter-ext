// Tier 2: zero-shot text classification with sentence embeddings.
//
// Each category is described by a handful of example "prototype" posts. A post
// is embedded once, compared (cosine similarity) against every prototype, and
// its score for a category is how much closer it is to that category than to
// ordinary, neutral posts. No training data or per-post API calls needed.
import type { Category, Strictness } from "./types";

/** Returns L2-normalised embeddings, one per input text. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

type TopicCategory = Exclude<Category, "offgoal">;

export const PROTOTYPES: Record<TopicCategory, string[]> = {
  sexualised: [
    "New spicy pics just dropped, link in my bio for the uncensored version",
    "Feeling cute in my new bikini, rate me 1 to 10",
    "She is so hot, look at that body",
    "Subscribe to see my private photos",
    "Explicit adult content, 18+ only",
    "Thirst trap selfie in lingerie",
    "Sexy model showing off her curves",
    "Hot guys shirtless at the beach",
  ],
  clickbait: [
    "You won't believe what happened next",
    "This one trick will change your life, most people don't know it",
    "Nobody is talking about this and it's insane",
    "I can't believe some of you actually think this",
    "Like and retweet if you agree",
    "It's happening. You know who you are.",
    "Some people really need to look in the mirror",
    "Wow. Just wow. Speechless.",
    "Unpopular opinion but somebody had to say it",
    "Reply with your answer, only 1% get this right",
    "BREAKING: something huge just happened, more soon",
    "They don't want you to know this",
  ],
  politics: [
    "The president signed a new executive order today",
    "Democrats and Republicans are fighting over the new bill in Congress",
    "Vote in the upcoming election, polls open tomorrow",
    "The government's immigration policy is a disaster",
    "The prime minister announced a new tax plan in parliament",
    "Left wing and right wing politicians clash over the budget",
    "The senator's campaign rally drew a huge crowd",
    "This administration is destroying the country",
    "Culture war debate about woke ideology",
  ],
  gossip: [
    "The famous singer was spotted on a date with her new boyfriend",
    "Celebrity couple confirms divorce after five years of marriage",
    "The rapper just dissed his rival in a new diss track",
    "Hollywood actress responds to cheating rumours",
    "The influencer drama is getting out of hand",
    "Reality TV star reveals secret pregnancy",
    "Pop star's outfit at the awards show has fans talking",
    "Inside the feud between the two famous YouTubers",
  ],
};

/** Ordinary posts used as a baseline: a post must be closer to a category than to these. */
export const NEUTRAL: string[] = [
  "Here's a tutorial on how to build a REST API with Node.js",
  "Just finished a 10k run, new personal best",
  "Our startup just shipped a new feature, here's what we learned",
  "Scientists discovered a new species of deep sea fish",
  "Easy weeknight recipe: garlic butter pasta in 20 minutes",
  "Thread on the lessons I learned from reading 50 books this year",
  "Beautiful sunset over the mountains on today's hike",
  "The new GPU benchmarks are out, here's how they compare",
  "Looking for recommendations for a good project management tool",
  "Happy birthday to my brother, love you man",
  "The match last night was incredible, what a goal",
  "Interest rates and what they mean for your savings",
  "My cat knocked everything off the desk again",
  "New paper on transformer architectures for protein folding",
  "Tips for staying focused while working from home",
  "Photos from my trip to Japan",
];

export interface Thresholds {
  /** Minimum (category similarity − neutral similarity) margin to hide. */
  margin: Record<TopicCategory, number>;
  /** Also require at least this raw similarity to the category. */
  minSim: Record<TopicCategory, number>;
  /** Off-goal: hide if relevance to every goal is below this. */
  goalRelevance: number;
}

// Calibrated on tests/data/labeled-posts.json with `npm run eval`.
export const THRESHOLDS: Record<Strictness, Thresholds> = {
  relaxed: {
    margin: { sexualised: 0.14, clickbait: 0.16, politics: 0.14, gossip: 0.14 },
    minSim: { sexualised: 0.3, clickbait: 0.3, politics: 0.3, gossip: 0.3 },
    goalRelevance: 0.25,
  },
  balanced: {
    margin: { sexualised: 0.1, clickbait: 0.11, politics: 0.1, gossip: 0.1 },
    minSim: { sexualised: 0.25, clickbait: 0.25, politics: 0.25, gossip: 0.25 },
    goalRelevance: 0.32,
  },
  strict: {
    margin: { sexualised: 0.06, clickbait: 0.08, politics: 0.06, gossip: 0.06 },
    minSim: { sexualised: 0.2, clickbait: 0.2, politics: 0.2, gossip: 0.2 },
    goalRelevance: 0.38,
  },
};

/**
 * Preset goals with example posts. A short phrase like "learning to code" is a
 * weak match for a post like "TIL git bisect finds bad commits"; real examples
 * of on-topic posts match far better. Custom goals still work via goalPhrasings.
 */
export const GOAL_PRESETS: { id: string; label: string; aliases: string[]; examples: string[] }[] = [
  {
    id: "coding",
    label: "Learning to code",
    aliases: ["code", "coding", "programming", "software", "developer", "web dev"],
    examples: [
      "Day 12 of learning JavaScript, finally understand async await",
      "TIL a useful git command for finding bugs",
      "Debugging tip: read the stack trace carefully",
      "Beginner's guide to Python data structures",
      "Solved today's LeetCode problem with two pointers",
      "How databases and SQL queries work",
      "Built a small side project with React and an API",
      "Code review advice for junior developers",
    ],
  },
  {
    id: "fitness",
    label: "Fitness & strength",
    aliases: ["fitness", "gym", "strength", "workout", "lifting", "running", "exercise", "health"],
    examples: [
      "New personal record on squat today",
      "My weekly training split for building muscle",
      "Progressive overload explained for beginners",
      "How much protein do you need to build muscle",
      "Morning run and stretching routine",
      "Proper deadlift form and common mistakes",
      "Cardio vs weights for fat loss",
      "Mobility work to fix tight hips",
    ],
  },
  {
    id: "business",
    label: "Business & startups",
    aliases: ["business", "startup", "entrepreneur", "founder", "marketing", "sales"],
    examples: [
      "Lessons from growing our startup to 10k users",
      "How to find your first customers",
      "Pricing strategy for a SaaS product",
      "We just raised our seed round, here's what we learned",
      "Marketing channels that worked for our small business",
      "How I validate business ideas before building",
    ],
  },
  {
    id: "science",
    label: "Science & tech news",
    aliases: ["science", "research", "technology", "tech", "ai", "space"],
    examples: [
      "New research paper shows surprising results",
      "NASA telescope captures image of a distant galaxy",
      "How the latest AI models work, explained",
      "Scientists discover a new treatment in clinical trials",
      "Breakthrough in battery technology",
    ],
  },
  {
    id: "finance",
    label: "Personal finance & investing",
    aliases: ["finance", "money", "investing", "saving", "budget", "stocks"],
    examples: [
      "How I budget my monthly income",
      "Index funds explained for beginners",
      "Compound interest and why starting early matters",
      "Paying off debt: avalanche vs snowball",
      "Building an emergency fund",
    ],
  },
  {
    id: "design",
    label: "Design & creativity",
    aliases: ["design", "art", "ui", "ux", "drawing", "photography", "creative"],
    examples: [
      "UI design tips for better readability",
      "My process for sketching a new illustration",
      "Typography basics every designer should know",
      "Photography composition rules explained",
      "Portfolio review: what makes a design stand out",
    ],
  },
  {
    id: "writing",
    label: "Writing & reading",
    aliases: ["writing", "reading", "books", "author", "blogging"],
    examples: [
      "Wrote 1000 words today on my novel",
      "Books that changed how I think",
      "Tips for writing clearer sentences",
      "My notes from this week's reading",
    ],
  },
  {
    id: "languages",
    label: "Learning languages",
    aliases: ["language", "languages", "spanish", "french", "japanese", "german"],
    examples: [
      "Day 100 of learning Spanish",
      "Useful phrases for beginners learning French",
      "How I practise speaking a new language every day",
      "Grammar tip for language learners",
    ],
  },
];

/** Example posts for a goal: preset examples if it matches a preset, plus generic phrasings. */
export function goalTexts(goal: string): string[] {
  const g = goal.trim().toLowerCase();
  const out = goalPhrasings(goal);
  for (const p of GOAL_PRESETS) {
    if (p.label.toLowerCase() === g || p.id === g || p.aliases.some((a) => new RegExp(`\\b${a}\\b`, "i").test(g))) {
      out.push(...p.examples);
    }
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const maxSim = (v: Float32Array, set: Float32Array[]) => set.reduce((m, p) => Math.max(m, dot(v, p)), -1);

/** Phrasings used to turn a short goal like "fitness" into something an embedding model matches well. */
export function goalPhrasings(goal: string): string[] {
  const g = goal.trim();
  return [g, `A post about ${g}`, `Tips, news and discussion about ${g}`];
}

export interface TextScores {
  /** Margin over neutral for each topic category (higher = more likely). */
  margin: Record<TopicCategory, number>;
  sim: Record<TopicCategory, number>;
  /** Best similarity to any of the user's goals (undefined when no goals). */
  goalRelevance?: number;
}

export class TextClassifier {
  private protoVecs?: Record<TopicCategory, Float32Array[]>;
  private neutralVecs?: Float32Array[];
  private goalCache = new Map<string, Float32Array[]>();

  private embed: EmbedFn;

  constructor(embed: EmbedFn) {
    this.embed = embed;
  }

  async init(): Promise<void> {
    if (this.protoVecs) return;
    const cats = Object.keys(PROTOTYPES) as TopicCategory[];
    const all = cats.flatMap((c) => PROTOTYPES[c]);
    const vecs = await this.embed([...all, ...NEUTRAL]);
    const out = {} as Record<TopicCategory, Float32Array[]>;
    let i = 0;
    for (const c of cats) {
      out[c] = vecs.slice(i, i + PROTOTYPES[c].length);
      i += PROTOTYPES[c].length;
    }
    this.neutralVecs = vecs.slice(i);
    this.protoVecs = out;
  }

  private async goalVecs(goals: string[]): Promise<Float32Array[]> {
    const key = goals.join("\n");
    let v = this.goalCache.get(key);
    if (!v) {
      v = await this.embed(goals.flatMap(goalTexts));
      this.goalCache.set(key, v);
    }
    return v;
  }

  async score(text: string, goals: string[] = []): Promise<TextScores> {
    await this.init();
    const [v] = await this.embed([text]);
    const neutral = maxSim(v, this.neutralVecs!);
    const margin = {} as Record<TopicCategory, number>;
    const sim = {} as Record<TopicCategory, number>;
    for (const c of Object.keys(this.protoVecs!) as TopicCategory[]) {
      sim[c] = maxSim(v, this.protoVecs![c]);
      margin[c] = sim[c] - neutral;
    }
    const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);
    const goalRelevance = cleanGoals.length ? maxSim(v, await this.goalVecs(cleanGoals)) : undefined;
    return { margin, sim, goalRelevance };
  }
}

/** Turn scores into the category (if any) that should hide the post. */
export function decideText(
  s: TextScores,
  enabled: Record<Category, boolean>,
  strictness: Strictness,
): { category: Category; score: number } | undefined {
  const t = THRESHOLDS[strictness];
  let best: { category: Category; score: number } | undefined;
  for (const c of Object.keys(s.margin) as TopicCategory[]) {
    if (!enabled[c]) continue;
    if (s.margin[c] >= t.margin[c] && s.sim[c] >= t.minSim[c]) {
      const score = s.margin[c] - t.margin[c];
      if (!best || score > best.score) best = { category: c, score };
    }
  }
  if (best) return best;
  if (enabled.offgoal && s.goalRelevance !== undefined && s.goalRelevance < t.goalRelevance) {
    return { category: "offgoal", score: t.goalRelevance - s.goalRelevance };
  }
  return undefined;
}
