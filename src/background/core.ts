// Shared background logic for Chrome and Firefox: routes classification
// requests to the AI engine, keeps daily stats and opens onboarding.
import { ext } from "../shared/ext";
import { getSettings, today } from "../shared/settings";
import type { DayStats, Msg, PostData, Settings, Verdict } from "../shared/types";

export interface Backend {
  classify(post: PostData, settings: Settings): Promise<Verdict>;
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

export function startBackground(backend: Backend): void {
  ext.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      ext.tabs.create({ url: ext.runtime.getURL("options.html?onboarding=1") });
    }
  });

  ext.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "classify":
        (async () => {
          const settings = await getSettings();
          const verdict = await backend.classify(msg.post, settings);
          void updateStats((s) => s.scanned++);
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
        return false;
      case "get-stats":
        getStats().then(sendResponse);
        return true;
    }
    return false;
  });
}
