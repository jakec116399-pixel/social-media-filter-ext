// Content script for x.com: finds each post as it appears, keeps it blurred
// until it has been checked, then reveals it or replaces it with a small bar.
import { ext } from "../shared/ext";
import { getSettings, onSettingsChanged } from "../shared/settings";
import type { Category, PostData, Settings, Verdict } from "../shared/types";
import { POST_SELECTOR, extractPost, mediaPending, quickPostId } from "./x-adapter";

const ROOT = document.documentElement;
const TIMEOUT_MS = 15000; // first model load can take several seconds on slow machines

let settings: Settings | null = null;
const verdicts = new Map<string, Verdict>(); // post id -> verdict
const revealed = new Set<string>(); // post ids the user chose to show
const counted = new Set<string>(); // post ids already counted as hidden

function anyCategory(s: Settings) {
  return Object.values(s.categories).some(Boolean);
}

function applySettings(s: Settings) {
  const changed = settings && JSON.stringify(settings) !== JSON.stringify(s);
  settings = s;
  const active = s.enabled && anyCategory(s);
  ROOT.classList.toggle("smf-off", !active);
  if (changed) {
    verdicts.clear();
    document.querySelectorAll(POST_SELECTOR).forEach((a) => resetArticle(a as HTMLElement));
  }
  if (active) {
    ext.runtime.sendMessage({ type: "warmup" }).catch(() => {});
    scheduleScan();
  } else {
    document.querySelectorAll(POST_SELECTOR).forEach((a) => resetArticle(a as HTMLElement));
  }
}

function resetArticle(a: HTMLElement) {
  delete a.dataset.smf;
  delete a.dataset.smfId;
  a.querySelector(":scope > .smf-bar")?.remove();
}

function classifyRemote(post: PostData): Promise<Verdict> {
  return Promise.race([
    ext.runtime.sendMessage({ type: "classify", post }) as Promise<Verdict>,
    new Promise<Verdict>((resolve) =>
      setTimeout(() => resolve({ hide: false, scores: {}, ms: TIMEOUT_MS, error: "timeout" }), TIMEOUT_MS),
    ),
  ]);
}

async function verdictFor(post: PostData, s: Settings): Promise<Verdict> {
  const cached = verdicts.get(post.id);
  if (cached) return cached;

  if (s.allowAccounts.includes(post.author)) return { hide: false, scores: {}, ms: 0 };

  // Keyword rules + on-device AI models (in the background / offscreen document).
  let v = await classifyRemote(post);
  for (let retry = 0; v.error && retry < 2; retry++) {
    console.warn("[Focus Feed] classify failed, retrying:", v.error);
    await new Promise((r) => setTimeout(r, 1000));
    v = await classifyRemote(post);
  }
  if (v.error) return v; // fail open, but don't cache so it is re-checked next time
  verdicts.set(post.id, v);
  return v;
}

const LABELS: Record<string, string> = {
  sexualised: "Sexualised",
  clickbait: "Clickbait",
  politics: "Politics",
  gossip: "Gossip",
  offgoal: "Relevance to your goals",
  image: "Suggestive image",
};

/** Tooltip text explaining a decision ("Why was this hidden?"). */
function explain(v: Verdict): string {
  const lines = Object.entries(v.scores)
    .filter(([, n]) => n !== undefined)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${LABELS[k] ?? k}: ${(n ?? 0).toFixed(2)}`);
  return [
    "Why was this hidden?",
    ...lines,
    "",
    "Wrong? Right-click the post → Focus Feed → Don't hide posts like this.",
  ].join("\n");
}

function render(article: HTMLElement, post: PostData, v: Verdict, s: Settings) {
  if (article.dataset.smfId !== post.id) return; // X reused this element for another post
  article.querySelector(":scope > .smf-bar")?.remove();
  if (!v.hide || revealed.has(post.id)) {
    article.dataset.smf = revealed.has(post.id) ? "revealed" : "ok";
    return;
  }
  article.dataset.smf = "hidden";
  article.dataset.smfStyle = s.hideStyle;

  if (!counted.has(post.id)) {
    counted.add(post.id);
    ext.runtime.sendMessage({ type: "hidden", category: v.category }).catch(() => {});
  }

  const bar = document.createElement("div");
  bar.className = "smf-bar";
  const label = document.createElement("span");
  label.className = "smf-label";
  label.textContent = `Hidden · ${v.reason ?? v.category}`;
  label.title = explain(v);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "smf-show";
  btn.textContent = "Show anyway";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    revealed.add(post.id);
    ext.runtime.sendMessage({ type: "override", category: v.category as Category, id: post.id }).catch(() => {});
    render(article, post, v, s);
  });
  bar.addEventListener("click", (e) => e.stopPropagation()); // don't open the post
  bar.append(label, btn);
  article.append(bar);
}

async function processArticle(article: HTMLElement) {
  const s = settings;
  if (!s || !s.enabled || !anyCategory(s)) return;
  // Fast path: already handled this exact post (most calls end here).
  if (article.dataset.smf && article.dataset.smfId && article.dataset.smfId === quickPostId(article)) return;
  const post = extractPost(article);
  if (!post) {
    article.dataset.smf = "ok"; // nothing to judge
    return;
  }
  if (article.dataset.smfId === post.id && article.dataset.smf && article.dataset.smf !== "pending") return;
  if (article.dataset.smfId === post.id && article.dataset.smf === "pending") return; // already in flight

  // Wait briefly for images so the image model sees them.
  if (s.categories.sexualised && mediaPending(article)) {
    setTimeout(() => scheduleScan(), 300);
    if (!article.dataset.smfWaits || Number(article.dataset.smfWaits) < 5) {
      article.dataset.smfWaits = String(Number(article.dataset.smfWaits ?? 0) + 1);
      return;
    }
  }

  article.dataset.smfId = post.id;
  article.dataset.smf = "pending";
  const v = await verdictFor(post, s);
  if (settings !== s) return; // settings changed meanwhile; a rescan will handle it
  render(article, post, v, s);
}

// Performance counters, exposed on <html> only when a test sets data-smf-debug.
let scanMs = 0;
let scans = 0;
function recordScan(ms: number) {
  scanMs += ms;
  scans++;
  if (ROOT.dataset.smfDebug !== undefined) ROOT.dataset.smfPerf = `${scans}:${scanMs.toFixed(1)}`;
}

let scanQueued = false;
function scheduleScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    const t0 = performance.now();
    document.querySelectorAll<HTMLElement>(POST_SELECTOR).forEach((a) => void processArticle(a));
    recordScan(performance.now() - t0);
  });
}

// Only rescan when new elements appear. X constantly updates counters and
// timestamps (text changes) while scrolling; those never need a rescan.
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const n of m.addedNodes) {
      if (n.nodeType === Node.ELEMENT_NODE && !(n as Element).classList.contains("smf-bar")) {
        scheduleScan();
        return;
      }
    }
  }
}).observe(ROOT, { childList: true, subtree: true });
// Remember which post was right-clicked, for "Focus Feed → Hide/Don't hide posts like this".
let lastContextArticle: Element | null = null;
document.addEventListener(
  "contextmenu",
  (e) => {
    lastContextArticle = (e.target as Element | null)?.closest?.(POST_SELECTOR) ?? null;
  },
  true,
);

ext.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
  if (msg.type === "feedback-collect") {
    sendResponse(lastContextArticle ? extractPost(lastContextArticle) : null);
    return false;
  }
  if (msg.type === "rescan") {
    // The user taught something new: re-check every post on the page.
    verdicts.clear();
    document.querySelectorAll(POST_SELECTOR).forEach((a) => resetArticle(a as HTMLElement));
    scheduleScan();
  }
  return false;
});

getSettings().then(applySettings);
onSettingsChanged(applySettings);
