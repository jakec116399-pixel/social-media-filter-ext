// Content script for x.com: finds each post as it appears, keeps it blurred
// until it has been checked, then reveals it or replaces it with a small bar.
import { ext } from "../shared/ext";
import { getSettings, onSettingsChanged } from "../shared/settings";
import {
  LABELS,
  isLocked,
  labelName,
  type Category,
  type LabelId,
  type Msg,
  type PostData,
  type Settings,
  type Verdict,
} from "../shared/types";
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

/** Tooltip text explaining a decision ("Why was this hidden?"). */
function explain(v: Verdict): string {
  const IMG: Record<string, string> = { imageExplicit: "Image: explicit", imageSexy: "Image: suggestive" };
  const name = (k: string) => IMG[k] ?? labelName(k as Category);
  const scores = Object.entries(v.scores)
    .filter(([, n]) => n !== undefined)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `  ${name(k)}: ${(n ?? 0).toFixed(2)}`);
  return [
    `Labels: ${(v.labels ?? []).map((l) => labelName(l)).join(" · ") || "none"}`,
    `Hidden because you hide: ${(v.hiddenBy ?? []).map(labelName).join(", ")}`,
    "",
    "Scores:",
    ...scores,
    "",
    "Wrong? Show it and use ✓ / ✗, or right-click the post → Focus Feed.",
  ].join("\n");
}

const taughtIds = new Set<string>(); // posts the user gave feedback on (this page session)

function stop(e: Event) {
  e.stopPropagation(); // don't let X open the post
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Subtle line on a post the user chose to show: how it was labelled, and
 * whether that was right, so the model can be reinforced or corrected.
 */
function feedbackNote(article: HTMLElement, post: PostData, v: Verdict, s: Settings): HTMLElement {
  const note = el("div", "smf-note");
  note.addEventListener("click", stop);
  const label = el("span", "smf-note-label", `Hidden as ${v.reason ?? labelName(v.category!)}`);
  label.title = explain(v);
  note.append(label);

  const send = (action: "hide" | "keep", labelId?: LabelId) => {
    taughtIds.add(post.id);
    ext.runtime.sendMessage({ type: "teach", post, action, label: labelId } satisfies Msg).catch(() => {});
    render(article, post, v, s);
  };

  if (taughtIds.has(post.id)) {
    note.append(el("span", "smf-note-thanks", "✓ Thanks, learned"));
    return note;
  }

  const actions = el("span", "smf-note-actions");
  const q = el("span", "smf-note-q", "Right?");
  const yes = el("button", "smf-note-btn", "✓");
  yes.type = "button";
  yes.title = "Yes, this was labelled correctly (reinforce)";
  const no = el("button", "smf-note-btn", "✗");
  no.type = "button";
  no.title = "No, this was labelled wrong";
  yes.addEventListener("click", (e) => {
    stop(e);
    const labels = (v.hiddenBy ?? []).filter((h): h is LabelId => h !== "offgoal");
    if (labels.length) send("hide", labels[0]);
    else {
      taughtIds.add(post.id);
      render(article, post, v, s);
    }
  });
  no.addEventListener("click", (e) => {
    stop(e);
    // Ask what it actually is.
    const select = el("select", "smf-note-select");
    const keepOpt = el("option", "", "Nothing to hide: don't hide posts like this");
    keepOpt.value = "keep";
    select.append(keepOpt);
    for (const [group, title] of [
      ["safety", "Safety"],
      ["topic", "It's actually about…"],
      ["tone", "Its tone is actually…"],
    ] as const) {
      const og = document.createElement("optgroup");
      og.label = title;
      for (const l of LABELS.filter((x) => x.group === group)) {
        const o = el("option", "", l.label);
        o.value = l.id;
        og.append(o);
      }
      select.append(og);
    }
    const save = el("button", "smf-note-btn smf-note-save", "Save");
    save.type = "button";
    save.addEventListener("click", (ev) => {
      stop(ev);
      if (select.value === "keep") send("keep");
      else send("hide", select.value as LabelId);
    });
    const cancel = el("button", "smf-note-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (ev) => {
      stop(ev);
      render(article, post, v, s);
    });
    actions.replaceChildren(select, save, cancel);
  });
  actions.append(q, yes, no);
  note.append(actions);
  return note;
}

function render(article: HTMLElement, post: PostData, v: Verdict, s: Settings) {
  if (article.dataset.smfId !== post.id) return; // X reused this element for another post
  article.querySelector(":scope > .smf-bar")?.remove();
  article.querySelector(":scope > .smf-note")?.remove();
  const locked = isLocked(s);
  if (!v.hide) {
    article.dataset.smf = "ok";
    return;
  }
  if (revealed.has(post.id) && !locked) {
    article.dataset.smf = "revealed";
    article.append(feedbackNote(article, post, v, s));
    return;
  }
  article.dataset.smf = "hidden";
  article.dataset.smfStyle = s.hideStyle;

  if (!counted.has(post.id)) {
    counted.add(post.id);
    ext.runtime.sendMessage({ type: "hidden", category: v.category }).catch(() => {});
  }

  const bar = el("div", "smf-bar");
  const label = el("span", "smf-label", `Hidden · ${v.reason ?? v.category}`);
  label.title = explain(v);
  bar.addEventListener("click", stop); // don't open the post
  bar.append(label);
  if (locked) {
    const lock = el("span", "smf-locked", "🔒 Locked");
    lock.title = "Strict mode lock is on: hidden posts can't be shown. Change this in Focus Feed settings.";
    bar.append(lock);
  } else {
    const btn = el("button", "smf-show", "Show anyway");
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      stop(e);
      revealed.add(post.id);
      ext.runtime.sendMessage({ type: "override", category: v.category as Category, id: post.id }).catch(() => {});
      render(article, post, v, s);
    });
    bar.append(btn);
  }
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
      if (
        n.nodeType === Node.ELEMENT_NODE &&
        !(n as Element).classList.contains("smf-bar") &&
        !(n as Element).closest(".smf-note")
      ) {
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
