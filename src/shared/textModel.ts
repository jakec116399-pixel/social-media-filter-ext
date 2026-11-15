// Zero-shot text classification with sentence embeddings.
//
// Labels and their example posts live in src/shared/prototypes.ts.
//  - Topics (what a post is about) compete with each other: a post's topic is
//    the one whose examples it is closest to, and a topic only counts if it is
//    the best (or nearly the best) match. Having many topics, including ones
//    nobody hides, gives every post a sensible home instead of forcing it into
//    the nearest hidden category.
//  - Tones (how a post is written) are judged separately: how much closer the
//    post is to, say, rage-bait examples than to plainly written posts.
// Posts are cleaned (links, @mentions, hashtags), and long posts are also
// scored sentence by sentence. No per-post API calls.
import { PLAIN, TONE_PROTOTYPES, TOPIC_PROTOTYPES } from "./prototypes.ts";
import {
  TONE_IDS,
  TOPIC_IDS,
  type Category,
  type LabelId,
  type Strictness,
  type ToneId,
  type TopicId,
  type UserExamples,
} from "./types.ts";

/** Returns L2-normalised embeddings, one per input text. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface Thresholds {
  /** Topic counts if its similarity is within this of the best topic (negative = allow near-ties). */
  topicLead: number;
  /** ...and its similarity is at least this. */
  topicFloor: number;
  /** Sexualised is stricter, because false alarms on it are upsetting. */
  sexualLead: number;
  sexualFloor: number;
  /** Tone counts if it beats plainly written posts by this margin. */
  tone: Record<ToneId, number>;
  /** Off-goal: hide if relevance to every goal is below this. */
  goalRelevance: number;
}

// Calibrated with `npm run eval -- --sweep` on tests/data/*.json.
export const THRESHOLDS: Record<Strictness, Thresholds> = {
  relaxed: {
    topicLead: 0.03,
    topicFloor: 0.25,
    sexualLead: 0.08,
    sexualFloor: 0.32,
    tone: { ragebait: 0.13, engagementbait: 0.13, vaguepost: 0.15, doom: 0.15, format: 0.15 },
    goalRelevance: 0.2,
  },
  balanced: {
    topicLead: 0.0,
    topicFloor: 0.22,
    sexualLead: 0.05,
    sexualFloor: 0.3,
    tone: { ragebait: 0.1, engagementbait: 0.1, vaguepost: 0.12, doom: 0.12, format: 0.1 },
    goalRelevance: 0.24,
  },
  strict: {
    topicLead: -0.02,
    topicFloor: 0.2,
    sexualLead: 0.02,
    sexualFloor: 0.27,
    tone: { ragebait: 0.07, engagementbait: 0.07, vaguepost: 0.09, doom: 0.09, format: 0.09 },
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
  if (!set.length) return -1;
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
  /** Per topic: similarity, and lead over the best other topic (≥ 0 means it is the top topic). */
  topic: Record<TopicId, { sim: number; lead: number }>;
  /** Per tone: margin over plainly written posts. */
  tone: Record<ToneId, number>;
  /** Best similarity to any of the user's goals (undefined when no goals). */
  goalRelevance?: number;
  /** Near-duplicate of a post the user taught: hide (with label) or keep. */
  taught?: { action: "hide"; label: LabelId } | { action: "keep" };
}

type VecSets = { topic: Record<TopicId, Float32Array[]>; tone: Record<ToneId, Float32Array[]>; plain: Float32Array[] };

export class TextClassifier {
  private base?: VecSets;
  private sets?: VecSets;
  private userHide: { label: LabelId; v: Float32Array }[] = [];
  private userKeep: Float32Array[] = [];
  private exampleKey = "";
  private embedCache = new Map<string, Float32Array>();
  private goalCache = new Map<string, Float32Array[]>();
  private embed: EmbedFn;

  /**
   * @param precomputed embeddings computed at build time (scripts/embed-prototypes.ts),
   *   so startup doesn't have to embed hundreds of example posts.
   */
  constructor(embed: EmbedFn, precomputed?: Map<string, Float32Array>) {
    this.embed = embed;
    if (precomputed) for (const [t, v] of precomputed) this.embedCache.set(t, v);
  }

  /** Embed texts, reusing cached / precomputed vectors. */
  private async embedCached(texts: string[]): Promise<Float32Array[]> {
    const missing = [...new Set(texts.filter((t) => !this.embedCache.has(t)))];
    if (missing.length) {
      const vecs = await this.embed(missing);
      missing.forEach((t, i) => this.embedCache.set(t, vecs[i]));
    }
    return texts.map((t) => this.embedCache.get(t)!);
  }

  async init(): Promise<void> {
    if (this.base) return;
    const groups: [string, string[]][] = [
      ...TOPIC_IDS.map((t) => [`topic:${t}`, TOPIC_PROTOTYPES[t]] as [string, string[]]),
      ...TONE_IDS.map((t) => [`tone:${t}`, TONE_PROTOTYPES[t]] as [string, string[]]),
      ["plain", PLAIN],
    ];
    const vecs = await this.embedCached(groups.flatMap(([, texts]) => texts));
    const out = { topic: {}, tone: {}, plain: [] } as unknown as VecSets;
    let i = 0;
    for (const [key, texts] of groups) {
      const slice = vecs.slice(i, i + texts.length);
      i += texts.length;
      if (key === "plain") out.plain = slice;
      else if (key.startsWith("topic:")) out.topic[key.slice(6) as TopicId] = slice;
      else out.tone[key.slice(5) as ToneId] = slice;
    }
    this.base = this.sets = out;
  }

  /** Version key for the current user examples (changes when they change). */
  get examplesVersion(): string {
    return this.exampleKey;
  }

  /** Add the user's taught examples to the label sets. */
  async setUserExamples(ex: UserExamples): Promise<void> {
    await this.init();
    const key = JSON.stringify(ex);
    if (key === this.exampleKey) return;
    const texts = [...ex.hide.map((h) => cleanText(h.text)), ...ex.keep.map(cleanText)];
    await this.embedCached(texts.filter(Boolean));
    const vec = (t: string) => this.embedCache.get(cleanText(t));
    this.userHide = ex.hide.flatMap((h) => {
      const v = vec(h.text);
      return v && (TOPIC_IDS as string[]).concat(TONE_IDS).includes(h.category) ? [{ label: h.category, v }] : [];
    });
    this.userKeep = ex.keep.flatMap((t) => (vec(t) ? [vec(t)!] : []));
    const b = this.base!;
    const extra = (id: LabelId) => this.userHide.filter((h) => h.label === id).map((h) => h.v);
    this.sets = {
      topic: Object.fromEntries(TOPIC_IDS.map((t) => [t, [...b.topic[t], ...extra(t)]])) as VecSets["topic"],
      tone: Object.fromEntries(TONE_IDS.map((t) => [t, [...b.tone[t], ...extra(t)]])) as VecSets["tone"],
      plain: [...b.plain, ...this.userKeep],
    };
    this.exampleKey = key;
  }

  private async goalVecs(goals: string[]): Promise<Float32Array[]> {
    const key = goals.join("\n");
    let v = this.goalCache.get(key);
    if (!v) {
      v = await this.embedCached(goals.flatMap(goalTexts));
      this.goalCache.set(key, v);
    }
    return v;
  }

  async score(text: string, goals: string[] = []): Promise<TextScores> {
    await this.init();
    const sets = this.sets!;
    const clean = cleanText(text) || text;
    const vecs = await this.embed(segments(clean));

    const topic = Object.fromEntries(TOPIC_IDS.map((t) => [t, { sim: -1, lead: -1 }])) as TextScores["topic"];
    const tone = Object.fromEntries(TONE_IDS.map((t) => [t, -1])) as TextScores["tone"];
    for (const v of vecs) {
      const sims = TOPIC_IDS.map((t) => topKSim(v, sets.topic[t]));
      for (let i = 0; i < TOPIC_IDS.length; i++) {
        let bestOther = -1;
        for (let j = 0; j < sims.length; j++) if (j !== i && sims[j] > bestOther) bestOther = sims[j];
        const lead = sims[i] - bestOther;
        const cur = topic[TOPIC_IDS[i]];
        if (lead > cur.lead) topic[TOPIC_IDS[i]] = { sim: sims[i], lead };
      }
      const plain = topKSim(v, sets.plain);
      for (const t of TONE_IDS) tone[t] = Math.max(tone[t], topKSim(v, sets.tone[t]) - plain);
    }

    // A post very similar to one the user explicitly taught follows that choice.
    let taught: TextScores["taught"];
    const NEAR = 0.82;
    let best = NEAR;
    for (const h of this.userHide) {
      const d = dot(vecs[0], h.v);
      if (d >= best) {
        best = d;
        taught = { action: "hide", label: h.label };
      }
    }
    for (const k of this.userKeep) {
      const d = dot(vecs[0], k);
      if (d >= best) {
        best = d;
        taught = { action: "keep" };
      }
    }

    const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);
    let goalRelevance: number | undefined;
    if (cleanGoals.length) {
      const gv = await this.goalVecs(cleanGoals);
      goalRelevance = Math.max(...vecs.map((v) => topKSim(v, gv, 2)));
    }
    return { topic, tone, goalRelevance, taught };
  }
}

export interface TextDecision {
  /** Every label the post was recognised as, strongest first (regardless of settings). */
  labels: LabelId[];
  /** Enabled labels (or "offgoal") that hide it. Empty = show. */
  hiddenBy: Category[];
}

/** Which labels apply at this strictness, and which of them the user hides. */
export function decideText(s: TextScores, enabled: Record<Category, boolean>, strictness: Strictness): TextDecision {
  const t = THRESHOLDS[strictness];
  const found: { id: LabelId; strength: number }[] = [];
  for (const id of TOPIC_IDS) {
    const { sim, lead } = s.topic[id];
    const [needLead, needFloor] = id === "sexualised" ? [t.sexualLead, t.sexualFloor] : [t.topicLead, t.topicFloor];
    if (lead >= needLead && sim >= needFloor) found.push({ id, strength: lead + 0.1 });
  }
  for (const id of TONE_IDS) {
    if (s.tone[id] >= t.tone[id]) found.push({ id, strength: s.tone[id] - t.tone[id] });
  }
  if (s.taught?.action === "hide" && !found.some((f) => f.id === (s.taught as { label: LabelId }).label)) {
    found.unshift({ id: s.taught.label, strength: 1 });
  }
  found.sort((a, b) => b.strength - a.strength);
  const labels = found.map((f) => f.id);
  if (s.taught?.action === "keep") return { labels, hiddenBy: [] };
  const hiddenBy: Category[] = labels.filter((id) => enabled[id]);
  if (!hiddenBy.length && enabled.offgoal && s.goalRelevance !== undefined && s.goalRelevance < t.goalRelevance) {
    hiddenBy.push("offgoal");
  }
  return { labels, hiddenBy };
}

/** The post's single closest topic (for display and evaluation). */
export function topTopic(s: TextScores): TopicId {
  let best = TOPIC_IDS[0];
  for (const t of TOPIC_IDS) if (s.topic[t].sim > s.topic[best].sim) best = t;
  return best;
}

/** Every fixed text whose embedding can be computed ahead of time. */
export function fixedTexts(): string[] {
  return [
    ...new Set([
      ...TOPIC_IDS.flatMap((t) => TOPIC_PROTOTYPES[t]),
      ...TONE_IDS.flatMap((t) => TONE_PROTOTYPES[t]),
      ...PLAIN,
      ...GOAL_PRESETS.flatMap((p) => [...goalPhrasings(p.label), ...p.examples]),
    ]),
  ];
}

/** Serialised form of precomputed embeddings (public/prototype-vectors.json). */
export interface PrecomputedFile {
  model: string;
  dim: number;
  texts: string[];
  /** base64 of a Float32Array of texts.length * dim values. */
  data: string;
}

export function decodePrecomputed(file: PrecomputedFile): Map<string, Float32Array> {
  const bin = atob(file.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const all = new Float32Array(bytes.buffer);
  return new Map(file.texts.map((t, i) => [t, all.slice(i * file.dim, (i + 1) * file.dim)]));
}
