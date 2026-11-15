// Shared background logic for Chrome and Firefox: routes classification
// requests to the AI engine, keeps daily stats and opens onboarding.
import { ext } from "../shared/ext";
import { getSettings, today } from "../shared/settings";
import {
  CATEGORIES,
  EMPTY_EXAMPLES,
  MAX_EXAMPLES,
  type DayStats,
  type DecisionLog,
  type Msg,
  type PostData,
  type Settings,
  type TopicCategory,
  type UserExamples,
  type Verdict,
} from "../shared/types";

export interface Backend {
  classify(post: PostData, settings: Settings, examples: UserExamples): Promise<Verdict>;
  warmup(): Promise<void>;
}

async function getStats(): Promise<DayStats> {
  const { stats } = (await ext.storage.local.get("stats")) as { stats?: DayStats };
  if (stats && stats.date === today()) return stats;
  return { date: today(), scanned: 0, hidden: {}, overrides: {} };
}

// Serialise stat updates so concurrent messages don't overwrite each other.
let statsQueue: Promise<unknown> = Promise.resolve();
function updateStats(fn: (s: DayStats) => void): Promise<void> {
  const run = statsQueue.then(async () => {
    const s = await getStats();
    fn(s);
    await ext.storage.local.set({ stats: s });
    const hidden = Object.values(s.hidden).reduce((a, b) => a + (b ?? 0), 0);
    await ext.action.setBadgeBackgroundColor({ color: "#4F46E5" });
    await ext.action.setBadgeText({ text: hidden ? String(hidden) : "" });
  });
  statsQueue = run.catch(() => {});
  return run;
}

// ---- What the user taught via right-click (stored locally) ----
async function getExamples(): Promise<UserExamples> {
  const { examples } = (await ext.storage.local.get("examples")) as { examples?: UserExamples };
  return { ...EMPTY_EXAMPLES, ...examples };
}
let examplesQueue: Promise<unknown> = Promise.resolve();
function updateExamples(fn: (e: UserExamples) => void): Promise<void> {
  const run = examplesQueue.then(async () => {
    const e = await getExamples();
    fn(e);
    e.hide = e.hide.slice(-MAX_EXAMPLES);
    e.keep = e.keep.slice(-MAX_EXAMPLES);
    await ext.storage.local.set({ examples: e });
  });
  examplesQueue = run.catch(() => {});
  return run;
}

// ---- Recent decisions, for the optional "Copy feedback report" ----
const LOG_MAX = 300;
let log: DecisionLog[] | null = null;
async function getLog(): Promise<DecisionLog[]> {
  log ??= ((await ext.storage.local.get("decisions")) as { decisions?: DecisionLog[] }).decisions ?? [];
  return log;
}
let logTimer: ReturnType<typeof setTimeout> | undefined;
async function addLog(entry: DecisionLog) {
  const l = await getLog();
  l.push(entry);
  if (l.length > LOG_MAX) l.splice(0, l.length - LOG_MAX);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => void ext.storage.local.set({ decisions: l }), 2000);
}

async function buildReport(): Promise<string> {
  const settings = await getSettings();
  const l = await getLog();
  return JSON.stringify(
    {
      version: ext.runtime.getManifest().version,
      settings: { ...settings, allowAccounts: settings.allowAccounts.length },
      taught: await getExamples(),
      decisions: l.slice(-150).map(({ id: _id, ...d }) => d),
    },
    null,
    1,
  );
}

const MENU_ROOT = "focus-feed";
async function createMenus() {
  const patterns = ["https://x.com/*", "https://twitter.com/*"];
  await ext.contextMenus.removeAll();
  {
    ext.contextMenus.create({ id: MENU_ROOT, title: "Focus Feed", contexts: ["all"], documentUrlPatterns: patterns });
    ext.contextMenus.create({
      id: "hide",
      parentId: MENU_ROOT,
      title: "Hide posts like this",
      contexts: ["all"],
      documentUrlPatterns: patterns,
    });
    for (const c of CATEGORIES) {
      if (c.id === "offgoal") continue;
      ext.contextMenus.create({
        id: `hide:${c.id}`,
        parentId: "hide",
        title: c.label,
        contexts: ["all"],
        documentUrlPatterns: patterns,
      });
    }
    ext.contextMenus.create({
      id: "keep",
      parentId: MENU_ROOT,
      title: "Don't hide posts like this",
      contexts: ["all"],
      documentUrlPatterns: patterns,
    });
  }
}

async function onMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (!tab?.id) return;
  const id = String(info.menuItemId);
  if (!id.startsWith("hide:") && id !== "keep") return;
  const post = (await ext.tabs.sendMessage(tab.id, { type: "feedback-collect" } satisfies Msg, {
    frameId: info.frameId,
  })) as PostData | null;
  if (!post?.text.trim()) return; // nothing to learn from (e.g. image-only post, or not on a post)
  const text = post.text.slice(0, 500);
  if (id === "keep") {
    await updateExamples((e) => {
      e.keep.push(text);
      e.hide = e.hide.filter((h) => h.text !== text);
    });
    // Also mark it as a mistake in the log.
    (await getLog()).filter((d) => d.id === post.id).forEach((d) => (d.overridden = true));
  } else {
    const category = id.slice(5) as TopicCategory;
    await updateExamples((e) => {
      e.hide.push({ category, text });
      e.keep = e.keep.filter((k) => k !== text);
    });
  }
  await broadcastRescan();
}

async function broadcastRescan() {
  const tabs = await ext.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const t of tabs) if (t.id) ext.tabs.sendMessage(t.id, { type: "rescan" } satisfies Msg).catch(() => {});
}

export function startBackground(backend: Backend): void {
  ext.contextMenus.onClicked.addListener((info, tab) => void onMenuClick(info, tab));
  ext.runtime.onInstalled.addListener((details) => {
    void createMenus();
    if (details.reason === "install") {
      ext.tabs.create({ url: ext.runtime.getURL("options.html?onboarding=1") });
    }
  });

  ext.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "classify":
        (async () => {
          const [settings, examples] = await Promise.all([getSettings(), getExamples()]);
          const verdict = await backend.classify(msg.post, settings, examples);
          void updateStats((s) => s.scanned++);
          if (!verdict.error) {
            void addLog({
              t: Date.now(),
              id: msg.post.id,
              text: msg.post.text.slice(0, 280),
              hide: verdict.hide,
              category: verdict.category,
              reason: verdict.reason,
              scores: verdict.scores,
            });
          }
          sendResponse(verdict);
        })().catch((e) => sendResponse({ hide: false, scores: {}, ms: 0, error: String(e) }));
        return true;
      case "warmup":
        backend.warmup().catch(() => {});
        return false;
      case "hidden":
        void updateStats((s) => (s.hidden[msg.category] = (s.hidden[msg.category] ?? 0) + 1));
        return false;
      case "override":
        void updateStats((s) => (s.overrides[msg.category] = (s.overrides[msg.category] ?? 0) + 1));
        void getLog().then((l) => l.filter((d) => d.id === msg.id).forEach((d) => (d.overridden = true)));
        return false;
      case "get-report":
        buildReport().then(sendResponse);
        return true;
      case "clear-learning":
        Promise.all([ext.storage.local.remove(["examples", "decisions"]), (log = [])])
          .then(broadcastRescan)
          .then(() => sendResponse(true));
        return true;
      case "get-stats":
        getStats().then(sendResponse);
        return true;
    }
    return false;
  });
}
