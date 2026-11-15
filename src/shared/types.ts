export type Category = "sexualised" | "clickbait" | "politics" | "gossip" | "offgoal";

export const CATEGORIES: { id: Category; label: string; description: string }[] = [
  { id: "sexualised", label: "Sexualised", description: "Suggestive or explicit images and text" },
  {
    id: "clickbait",
    label: "Clickbait & vagueposts",
    description: "Engagement bait, outrage bait, cryptic posts with no substance",
  },
  { id: "politics", label: "Politics", description: "Elections, parties, politicians, culture-war arguments" },
  { id: "gossip", label: "Celebrity & gossip", description: "Celebrity drama, relationships, influencer beef" },
  { id: "offgoal", label: "Off-goal", description: "Anything not related to the goals you set" },
];

export type Strictness = "relaxed" | "balanced" | "strict";
export type HideStyle = "collapse" | "blur";

export interface Settings {
  enabled: boolean;
  onboarded: boolean;
  categories: Record<Category, boolean>;
  goals: string[];
  strictness: Strictness;
  hideStyle: HideStyle;
  /** Lower-case handles (without @) whose posts are never filtered. */
  allowAccounts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  onboarded: false,
  categories: { sexualised: true, clickbait: true, politics: false, gossip: false, offgoal: false },
  goals: [],
  strictness: "balanced",
  hideStyle: "collapse",
  allowAccounts: [],
};

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
  /** Category that triggered the hide (if any). */
  category?: Category;
  /** Short human-readable reason. */
  reason?: string;
  /** Category scores, plus `image` (sexualised-image probability) when images were checked. */
  scores: Partial<Record<Category | "image", number>>;
  ms: number;
  /** Set when classification failed (e.g. models still loading). */
  error?: string;
}

export type TopicCategory = Exclude<Category, "offgoal">;

/** Examples the user taught via right-click. Stored locally only. */
export interface UserExamples {
  hide: { category: TopicCategory; text: string }[];
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
  scores: Partial<Record<Category | "image", number>>;
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
  | { type: "rescan" }
  | { type: "warmup" };

export interface DayStats {
  date: string;
  scanned: number;
  hidden: Partial<Record<Category, number>>;
  overrides: Partial<Record<Category, number>>;
}
