// Service worker: routes classification requests to the offscreen document
// (where the AI models live), keeps daily stats and opens onboarding.
import { getSettings, today } from "../shared/settings";
import type { DayStats, Msg, Verdict } from "../shared/types";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html?onboarding=1") });
  }
});

let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Run on-device AI models that classify feed posts.",
      })
      .catch((e) => {
        if (!String(e).includes("single offscreen")) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

/** Send to the offscreen document, retrying while its scripts are still starting up. */
async function sendToOffscreen<T>(msg: Msg): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(msg)) as T;
    } catch (e) {
      if (attempt >= 50 || !String(e).includes("Receiving end does not exist")) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function getStats(): Promise<DayStats> {
  const { stats } = (await chrome.storage.local.get("stats")) as { stats?: DayStats };
  if (stats && stats.date === today()) return stats;
  return { date: today(), scanned: 0, hidden: {}, overrides: {} };
}

// Serialise stat updates so concurrent messages don't overwrite each other.
let statsQueue: Promise<unknown> = Promise.resolve();
function updateStats(fn: (s: DayStats) => void): Promise<void> {
  const run = statsQueue.then(async () => {
    const s = await getStats();
    fn(s);
    await chrome.storage.local.set({ stats: s });
    const hidden = Object.values(s.hidden).reduce((a, b) => a + (b ?? 0), 0);
    await chrome.action.setBadgeBackgroundColor({ color: "#4F46E5" });
    await chrome.action.setBadgeText({ text: hidden ? String(hidden) : "" });
  });
  statsQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "classify":
      (async () => {
        const settings = await getSettings();
        await ensureOffscreen();
        const verdict = await sendToOffscreen<Verdict>({ type: "offscreen-classify", post: msg.post, settings });
        void updateStats((s) => s.scanned++);
        sendResponse(verdict);
      })().catch((e) => sendResponse({ hide: false, scores: {}, ms: 0, error: String(e) }));
      return true;
    case "warmup":
      ensureOffscreen()
        .then(() => sendToOffscreen({ type: "warmup" }))
        .catch(() => {});
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
