// Tier 2: zero-shot text classification with sentence embeddings.
//
// Each category is described by example posts (src/shared/prototypes.ts). A
// post is cleaned, embedded, and compared (cosine similarity) with every
// example. Its score for a category is how much closer it is to that
// category's best matches than to ordinary, neutral posts. Long posts are also
// scored sentence by sentence, so one political line in a long post counts.
// No training data or per-post API calls needed.
import { NEUTRAL, PROTOTYPES } from "./prototypes.ts";
import type { Category, Strictness, TopicCategory, UserExamples } from "./types";

export { NEUTRAL, PROTOTYPES };

/** Returns L2-normalised embeddings, one per input text. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export type { TopicCategory };
export const TOPIC_CATEGORIES = Object.keys(PROTOTYPES) as TopicCategory[];

export interface Thresholds {
  /** Minimum (category similarity − neutral similarity) margin to hide. */
  margin: Record<TopicCategory, number>;
  /** Off-goal: hide if relevance to every goal is below this. */
  goalRelevance: number;
}

// Calibrated on tests/data/labeled-posts.json with `npm run eval`.
// Calibrated with `npm run eval -- --sweep`, mostly on tests/data/realistic-posts.json
// (messy, real-looking posts that were not used to write the prototypes).
export const THRESHOLDS: Record<Strictness, Thresholds> = {
  relaxed: {
    margin: { sexualised: 0.12, clickbait: 0.1, politics: 0.1, gossip: 0.1 },
    goalRelevance: 0.2,
  },
  balanced: {
    margin: { sexualised: 0.08, clickbait: 0.06, politics: 0.06, gossip: 0.06 },
    goalRelevance: 0.24,
  },
  strict: {
    margin: { sexualised: 0.06, clickbait: 0.02, politics: 0.02, gossip: 0.02 },
    goalRelevance: 0.28,
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

/** Mean of the k highest similarities: steadier than trusting the single closest example. */
function topKSim(v: Float32Array, set: Float32Array[], k = 3): number {
  const sims = set.map((p) => dot(v, p)).sort((a, b) => b - a);
  const n = Math.min(k, sims.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sims[i];
  return sum / n;
}

/** Strip the parts of real posts that confuse matching: links, @mentions, '#', X's "Show more". */
export function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ly|gg|tv|me|app|dev)(?:\/\S*)?/gi, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/#(\w+)/g, (_, tag: string) => tag.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .replace(/\bShow more\b/g, " ")
    .replace(/…/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The whole post, plus its individual sentences when it has several. */
export function segments(clean: string): string[] {
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.split(/\s+/).length >= 4);
  return sentences.length > 1 ? [clean, ...sentences.slice(0, 4)] : [clean];
}

/** Phrasings used to turn a short goal like "fitness" into something an embedding model matches well. */
export function goalPhrasings(goal: string): string[] {
  const g = goal.trim();
  return [g, `A post about ${g}`, `Tips, news and discussion about ${g}`];
}

export interface TextScores {
  /** Margin over neutral for each topic category (higher = more likely). */
  margin: Record<TopicCategory, number>;
  /** Near-duplicate of a post the user taught: hide (with category) or keep. */
  taught?: { action: "hide"; category: TopicCategory } | { action: "keep" };
  /** Best similarity to any of the user's goals (undefined when no goals). */
  goalRelevance?: number;
}

export class TextClassifier {
  private baseProto?: Record<TopicCategory, Float32Array[]>;
  private baseNeutral?: Float32Array[];
  private protoVecs?: Record<TopicCategory, Float32Array[]>;
  private neutralVecs?: Float32Array[];
  private userHide: { category: TopicCategory; v: Float32Array }[] = [];
  private userKeep: Float32Array[] = [];
  private exampleKey = "";
  private embedCache = new Map<string, Float32Array>();
  private goalCache = new Map<string, Float32Array[]>();

  private embed: EmbedFn;

  constructor(embed: EmbedFn) {
    this.embed = embed;
  }

  async init(): Promise<void> {
    if (this.protoVecs) return;
    const all = TOPIC_CATEGORIES.flatMap((c) => [...PROTOTYPES[c]]);
    const vecs = await this.embed([...all, ...NEUTRAL]);
    const out = {} as Record<TopicCategory, Float32Array[]>;
    let i = 0;
    for (const c of TOPIC_CATEGORIES) {
      out[c] = vecs.slice(i, i + PROTOTYPES[c].length);
      i += PROTOTYPES[c].length;
    }
    this.baseNeutral = this.neutralVecs = vecs.slice(i);
    this.baseProto = this.protoVecs = out;
  }

  /** Version key for the current user examples (changes when they change). */
  get examplesVersion(): string {
    return this.exampleKey;
  }

  /** Add the user's taught examples to the category and neutral sets. */
  async setUserExamples(ex: UserExamples): Promise<void> {
    await this.init();
    const key = JSON.stringify(ex);
    if (key === this.exampleKey) return;
    const texts = [...ex.hide.map((h) => cleanText(h.text)), ...ex.keep.map(cleanText)];
    const missing = [...new Set(texts.filter((t) => t && !this.embedCache.has(t)))];
    if (missing.length) {
      const vecs = await this.embed(missing);
      missing.forEach((t, i) => this.embedCache.set(t, vecs[i]));
    }
    const vec = (t: string) => this.embedCache.get(cleanText(t));
    this.userHide = ex.hide.flatMap((h) => (vec(h.text) ? [{ category: h.category, v: vec(h.text)! }] : []));
    this.userKeep = ex.keep.flatMap((t) => (vec(t) ? [vec(t)!] : []));
    const proto = {} as Record<TopicCategory, Float32Array[]>;
    for (const c of TOPIC_CATEGORIES) {
      proto[c] = [...this.baseProto![c], ...this.userHide.filter((h) => h.category === c).map((h) => h.v)];
    }
    this.protoVecs = proto;
    this.neutralVecs = [...this.baseNeutral!, ...this.userKeep];
    this.exampleKey = key;
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
    const clean = cleanText(text) || text;
    const segs = segments(clean);
    const vecs = await this.embed(segs);
    const margin = {} as Record<TopicCategory, number>;
    for (const c of TOPIC_CATEGORIES) margin[c] = -1;
    for (const v of vecs) {
      const neutral = topKSim(v, this.neutralVecs!);
      for (const c of TOPIC_CATEGORIES) {
        margin[c] = Math.max(margin[c], topKSim(v, this.protoVecs![c]) - neutral);
      }
    }
    // A post very similar to one the user explicitly taught follows that choice.
    let taught: TextScores["taught"];
    const NEAR = 0.82;
    for (const v of vecs.slice(0, 1)) {
      let best = NEAR;
      for (const h of this.userHide) {
        const d = dot(v, h.v);
        if (d >= best) {
          best = d;
          taught = { action: "hide", category: h.category };
        }
      }
      for (const k of this.userKeep) {
        const d = dot(v, k);
        if (d >= best) {
          best = d;
          taught = { action: "keep" };
        }
      }
    }
    const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);
    let goalRelevance: number | undefined;
    if (cleanGoals.length) {
      const gv = await this.goalVecs(cleanGoals);
      goalRelevance = Math.max(...vecs.map((v) => topKSim(v, gv, 2)));
    }
    return { margin, goalRelevance, taught };
  }
}

/** Turn scores into the category (if any) that should hide the post. */
export function decideText(
  s: TextScores,
  enabled: Record<Category, boolean>,
  strictness: Strictness,
): { category: Category; score: number } | undefined {
  const t = THRESHOLDS[strictness];
  if (s.taught?.action === "keep") return undefined;
  if (s.taught?.action === "hide" && enabled[s.taught.category]) return { category: s.taught.category, score: 1 };
  // Among enabled categories that pass their threshold, pick the strongest match.
  let best: { category: Category; score: number } | undefined;
  for (const c of TOPIC_CATEGORIES) {
    if (!enabled[c] || s.margin[c] < t.margin[c]) continue;
    if (!best || s.margin[c] > best.score) best = { category: c, score: s.margin[c] };
  }
  if (best) return best;
  if (enabled.offgoal && s.goalRelevance !== undefined && s.goalRelevance < t.goalRelevance) {
    return { category: "offgoal", score: t.goalRelevance - s.goalRelevance };
  }
  return undefined;
}

/** The single most likely topic category (for explaining decisions). */
export function topCategory(s: TextScores): { category: TopicCategory; margin: number } {
  let best = TOPIC_CATEGORIES[0];
  for (const c of TOPIC_CATEGORIES) if (s.margin[c] > s.margin[best]) best = c;
  return { category: best, margin: s.margin[best] };
}
