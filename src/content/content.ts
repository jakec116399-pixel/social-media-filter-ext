// Content script for x.com: finds each post as it appears, keeps it blurred
// until it has been checked, then reveals it or replaces it with a small bar.
import { ext } from "../shared/ext";
import { heuristicHits } from "../shared/heuristics";
import { getSettings, onSettingsChanged } from "../shared/settings";
import type { Category, PostData, Settings, Verdict } from "../shared/types";
import { POST_SELECTOR, extractPost, mediaPending } from "./x-adapter";

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

  // Tier 1: instant keyword checks.
  const hit = heuristicHits(post).find((h) => s.categories[h.category]);
  let v: Verdict;
  if (hit) {
    v = { hide: true, category: hit.category, reason: hit.reason, scores: {}, ms: 0 };
  } else {
    // Tier 2+: on-device AI models (via background → offscreen document).
    v = await classifyRemote(post);
    for (let retry = 0; v.error && retry < 2; retry++) {
      console.warn("[Focus Feed] classify failed, retrying:", v.error);
      await new Promise((r) => setTimeout(r, 1000));
      v = await classifyRemote(post);
    }
    if (v.error) return v; // fail open, but don't cache so it is re-checked next time
  }
  verdicts.set(post.id, v);
  return v;
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
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "smf-show";
  btn.textContent = "Show anyway";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    revealed.add(post.id);
    ext.runtime.sendMessage({ type: "override", category: v.category as Category }).catch(() => {});
    render(article, post, v, s);
  });
  bar.addEventListener("click", (e) => e.stopPropagation()); // don't open the post
  bar.append(label, btn);
  article.append(bar);
}

async function processArticle(article: HTMLElement) {
  const s = settings;
  if (!s || !s.enabled || !anyCategory(s)) return;
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

let scanQueued = false;
function scheduleScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    document.querySelectorAll<HTMLElement>(POST_SELECTOR).forEach((a) => void processArticle(a));
  });
}

new MutationObserver(() => scheduleScan()).observe(ROOT, { childList: true, subtree: true });
getSettings().then(applySettings);
onSettingsChanged(applySettings);
