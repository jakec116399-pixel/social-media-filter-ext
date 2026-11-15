// Labels come in three groups. Topics describe what a post is about and compete
// with each other (every post gets its closest topic). Tones describe how it's
// written and are judged independently. A post can have several labels.
export type TopicId =
  | "sexualised"
  | "politics"
  | "news"
  | "gossip"
  | "sports"
  | "entertainment"
  | "memes"
  | "money"
  | "tech"
  | "learning"
  | "fitness"
  | "lifestyle"
  | "personal"
  | "relationships"
  | "ads";
export type ToneId = "ragebait" | "engagementbait" | "vaguepost" | "doom" | "format";
export type LabelId = TopicId | ToneId;
/** Anything that can hide a post: a label, or "off-goal" mode. */
export type Category = LabelId | "offgoal";
export type LabelGroup = "safety" | "topic" | "tone";

export interface LabelDef {
  id: LabelId;
  group: LabelGroup;
  label: string;
  description: string;
}

export const LABELS: LabelDef[] = [
  { id: "sexualised", group: "safety", label: "Sexualised", description: "Suggestive or explicit images and text" },
  { id: "politics", group: "topic", label: "Politics", description: "Elections, parties, politicians, policy fights" },
  { id: "news", group: "topic", label: "News & events", description: "Breaking news, disasters, crime, world events" },
  {
    id: "gossip",
    group: "topic",
    label: "Celebrity & gossip",
    description: "Celebrity drama, breakups, influencer beef",
  },
  { id: "sports", group: "topic", label: "Sports", description: "Matches, transfers, athletes, fan arguments" },
  {
    id: "entertainment",
    group: "topic",
    label: "Film, TV, music & gaming",
    description: "Releases, reviews, trailers, fandoms",
  },
  { id: "memes", group: "topic", label: "Memes & humour", description: "Jokes, shitposts, relatable memes" },
  {
    id: "money",
    group: "topic",
    label: "Money, crypto & hustle",
    description: "Crypto, trading, get-rich schemes, side hustles",
  },
  { id: "tech", group: "topic", label: "Tech & science", description: "Technology, AI, research, space" },
  {
    id: "learning",
    group: "topic",
    label: "Learning & education",
    description: "Tutorials, courses, study tips, how-tos",
  },
  { id: "fitness", group: "topic", label: "Health & fitness", description: "Training, nutrition, running, wellbeing" },
  { id: "lifestyle", group: "topic", label: "Food, travel & lifestyle", description: "Recipes, trips, fashion, home" },
  {
    id: "personal",
    group: "topic",
    label: "Personal updates",
    description: "Life news, family, pets, everyday moments",
  },
  {
    id: "relationships",
    group: "topic",
    label: "Relationships & dating",
    description: "Dating discourse, gender wars, relationship takes",
  },
  { id: "ads", group: "topic", label: "Ads & promotion", description: "Product promos, giveaways, affiliate links" },
  {
    id: "ragebait",
    group: "tone",
    label: "Rage bait",
    description: "Posts designed to make you angry or start fights",
  },
  {
    id: "engagementbait",
    group: "tone",
    label: "Engagement bait",
    description: '"Like if…", "you won\'t believe…", reply-farming',
  },
  { id: "vaguepost", group: "tone", label: "Vagueposting", description: "Cryptic posts with no actual content" },
  {
    id: "doom",
    group: "tone",
    label: "Doom & negativity",
    description: "Doomscrolling fuel: everything is collapsing",
  },
  {
    id: "format",
    group: "tone",
    label: "Trend formats",
    description: 'Templated posts: "> be me" greentext, "POV:", "nobody: / me:", "tell me … without telling me"',
  },
];

export const LABEL_BY_ID = Object.fromEntries(LABELS.map((l) => [l.id, l])) as Record<LabelId, LabelDef>;
export const TOPIC_IDS = LABELS.filter((l) => l.group !== "tone").map((l) => l.id) as TopicId[];
export const TONE_IDS = LABELS.filter((l) => l.group === "tone").map((l) => l.id) as ToneId[];

export function labelName(id: Category): string {
  return id === "offgoal" ? "Not related to your goals" : (LABEL_BY_ID[id]?.label ?? id);
}

export type Strictness = "relaxed" | "balanced" | "strict";
export type HideStyle = "collapse" | "blur";

export interface Settings {
  enabled: boolean;
  onboarded: boolean;
  /** Which labels hide a post (plus "offgoal" for goal mode). */
  categories: Record<Category, boolean>;
  goals: string[];
  strictness: Strictness;
  hideStyle: HideStyle;
  /** Strict mode only: hidden posts can't be unhidden (no "Show anyway", no un-teaching). */
  lockHidden: boolean;
  /** Lower-case handles (without @) whose posts are never filtered. */
  allowAccounts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  onboarded: false,
  categories: {
    ...(Object.fromEntries(LABELS.map((l) => [l.id, false])) as Record<LabelId, boolean>),
    sexualised: true,
    ragebait: true,
    engagementbait: true,
    vaguepost: true,
    offgoal: false,
  },
  goals: [],
  strictness: "balanced",
  hideStyle: "collapse",
  lockHidden: false,
  allowAccounts: [],
};

/** Whether hidden posts are locked (lock only applies in strict mode). */
export const isLocked = (s: Settings) => s.lockHidden && s.strictness === "strict";

/** What the content script extracts from one post. */
export interface PostData {
  id: string;
  author: string;
  text: string;
  imageUrls: string[];
  hasLink: boolean;
  hasMedia: boolean;
}

export interface Verdict {
  hide: boolean;
  /** Everything the post was recognised as (hidden or not), strongest first. */
  labels?: LabelId[];
  /** The enabled labels that caused it to be hidden. */
  hiddenBy?: Category[];
  /** Category that triggered the hide (if any). */
  category?: Category;
  /** Short human-readable reason. */
  reason?: string;
  /** Label scores, plus image-model scores (explicit, suggestive) when images were checked. */
  scores: Partial<Record<Category | "imageExplicit" | "imageSexy", number>>;
  ms: number;
  /** Set when classification failed (e.g. models still loading). */
  error?: string;
}

/** Examples the user taught via right-click. Stored locally only. */
export interface UserExamples {
  hide: { category: LabelId; text: string }[];
  keep: string[];
}
export const EMPTY_EXAMPLES: UserExamples = { hide: [], keep: [] };
export const MAX_EXAMPLES = 300;

/** One logged decision, for the optional feedback report. */
export interface DecisionLog {
  t: number;
  text: string;
  hide: boolean;
  category?: Category;
  reason?: string;
  scores: Partial<Record<Category | "imageExplicit" | "imageSexy", number>>;
  overridden?: boolean;
  id: string;
}

/** Messages between content script, background and offscreen document. */
export type Msg =
  | { type: "classify"; post: PostData }
  | { type: "offscreen-classify"; post: PostData; settings: Settings; examples: UserExamples }
  | { type: "hidden"; category: Category }
  | { type: "override"; category: Category; id: string }
  | { type: "get-stats" }
  | { type: "get-report" }
  | { type: "clear-learning" }
  | { type: "feedback-collect" }
  | { type: "teach"; post: PostData; action: "hide" | "keep"; label?: LabelId; enable?: boolean }
  | { type: "rescan" }
  | { type: "warmup" };

export interface DayStats {
  date: string;
  scanned: number;
  hidden: Partial<Record<Category, number>>;
  overrides: Partial<Record<Category, number>>;
}
