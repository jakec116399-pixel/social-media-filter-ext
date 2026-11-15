// End-to-end test: loads the built extension into Chromium, serves a mock X
// timeline at https://x.com/home, and checks which posts get hidden.
//   npm run build && npm run e2e            (add --screens to save screenshots)
import { chromium } from "playwright";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist", "chrome");
const outDir = join(root, "test-results");
const screens = process.argv.includes("--screens");
await mkdir(outDir, { recursive: true });

// Posts NOT in the calibration set, to check the filter generalises.
const POSTS = [
  { user: "devtips", name: "Dev Tips", text: "Quick tip: use `git stash -p` to stash only part of your changes", expect: "show", goal: true },
  { user: "spicyacc", name: "🍒", text: "My new photoshoot is too hot for here 🔥 check my bio for the full set", expect: "sexualised" },
  { user: "pundit", name: "Political Pundit", text: "The opposition leader's speech in parliament today was a masterclass in hypocrisy", expect: "politics" },
  { user: "lifter", name: "Strong Sam", text: "Finally benched 100kg after 8 months of consistent training 💪", img: "chart.jpg", expect: "show", goal: true },
  { user: "vague", name: "anon", text: "some people really think they're untouchable lol", expect: "clickbait" },
  { user: "popcorn", name: "Pop Culture Daily", text: "The pop star and her actor boyfriend reportedly split after two years together", expect: "gossip" },
  { user: "hiker", name: "Trail Notes", text: "Sunrise from the summit this morning", img: "landscape.jpg", expect: "show", goal: false },
  { user: "bait", name: "Viral", text: "Only 2% of people can find the mistake in this picture. Can you?", expect: "clickbait" },
  // Arrive later (infinite scroll)
  { user: "rustlang", name: "Rust Learner", text: "Wrote my first async web server in Rust, the borrow checker finally clicked", img: "code.jpg", expect: "show", goal: true },
  { user: "news", name: "Politics Now", text: "Polls tighten as both candidates make their final push before Tuesday's vote", expect: "politics" },
  { user: "foodie", name: "Weeknight Cook", text: "15 minute chickpea curry, recipe in the replies", expect: "show", goal: false },
  { user: "drama", name: "Tea Spill", text: "This influencer's fake apology video is getting ratioed into oblivion", expect: "gossip" },
];

const fixture = await readFile(join(root, "tests/fixtures/x-home.html"), "utf8");
const images = {};
for (const f of ["landscape.jpg", "code.jpg", "chart.jpg"]) images[f] = await readFile(join(root, "tests/fixtures/img", f));

const profile = join(root, ".e2e-profile");
await rm(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  // Use a locally installed Chromium if set (e.g. CHROMIUM_PATH=/opt/pw-browsers/chromium).
  executablePath: process.env.CHROMIUM_PATH || undefined,
  viewport: { width: 1000, height: 1400 },
  deviceScaleFactor: screens ? 2 : 1,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

const logs = [];
ctx.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
await ctx.route("https://x.com/**", (route) =>
  route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: fixture })
    : route.fulfill({ status: 404, body: "" }),
);
await ctx.route("https://pbs.twimg.com/**", (route) => {
  const name = new URL(route.request().url()).pathname.split("/").pop();
  return images[name] ? route.fulfill({ contentType: "image/jpeg", body: images[name] }) : route.fulfill({ status: 404 });
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;

async function setSettings(settings) {
  await sw.evaluate((s) => chrome.storage.sync.set({ settings: s }), settings);
}
const base = {
  enabled: true, onboarded: true, strictness: "balanced", hideStyle: "collapse", allowAccounts: [], goals: [],
  categories: { sexualised: true, clickbait: true, politics: true, gossip: true, offgoal: false },
};

async function runFeed(label, settings, expectFn) {
  await setSettings(settings);
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`[page ${m.type()}] ${m.text()}`));
  await page.addInitScript((posts) => (window.__POSTS__ = posts), POSTS);
  const t0 = Date.now();
  await page.goto("https://x.com/home");
  // Wait until every post has a verdict.
  await page.waitForFunction(
    (n) => {
      const a = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return a.length === n && a.every((x) => ["ok", "hidden", "revealed"].includes(x.dataset.smf));
    },
    POSTS.length,
    { timeout: 60000 },
  );
  const elapsed = Date.now() - t0;
  const results = await page.$$eval('article[data-testid="tweet"]', (as) =>
    as.map((a) => ({ state: a.dataset.smf, reason: a.querySelector(".smf-label")?.textContent ?? "" })),
  );
  let correct = 0;
  console.log(`\n== ${label} (all ${POSTS.length} posts judged in ${elapsed} ms, including first model load)`);
  results.forEach((r, i) => {
    const want = expectFn(POSTS[i]);
    const got = r.state === "hidden" ? "hidden" : "shown";
    const ok = want === got;
    if (ok) correct++;
    console.log(`  ${ok ? "✓" : "✗"} ${got.padEnd(6)} ${r.reason.padEnd(38)} ${POSTS[i].text.slice(0, 60)}`);
  });
  console.log(`  ${correct}/${POSTS.length} as expected`);
  return { page, correct };
}

// 1) Topic filters on.
const r1 = await runFeed("Sexualised + clickbait + politics + gossip", base, (p) => (p.expect === "show" ? "shown" : "hidden"));
if (screens) await r1.page.screenshot({ path: join(outDir, "feed-collapse.png"), fullPage: true });

// "Show anyway" reveals the post.
const firstHidden = r1.page.locator('article[data-smf="hidden"]').first();
await firstHidden.locator(".smf-show").click();
await r1.page.waitForTimeout(200);
assert.equal(await r1.page.locator('article[data-smf="revealed"]').count(), 1, "Show anyway should reveal the post");
console.log("  ✓ 'Show anyway' reveals a hidden post");

// Teaching: right-click a hidden post → "Don't hide posts like this" must unhide it.
{
  const target = r1.page.locator('article[data-smf="hidden"]').nth(1);
  const text = await target.locator('[data-testid="tweetText"]').innerText();
  await target.dispatchEvent("contextmenu");
  // Do what the context-menu handler does (Playwright can't click native menus).
  const pageUrl = r1.page.url();
  await sw.evaluate(async ({ url }) => {
    const [tab] = await chrome.tabs.query({ url });
    const post = await chrome.tabs.sendMessage(tab.id, { type: "feedback-collect" });
    const { examples = { hide: [], keep: [] } } = await chrome.storage.local.get("examples");
    examples.keep.push(post.text);
    await chrome.storage.local.set({ examples });
    await chrome.tabs.sendMessage(tab.id, { type: "rescan" });
  }, { url: pageUrl });
  await r1.page.waitForFunction(
    (t) => [...document.querySelectorAll('article[data-testid="tweet"]')].some(
      (a) => a.innerText.includes(t) && a.dataset.smf === "ok"),
    text, { timeout: 15000 },
  );
  console.log(`  ✓ Teaching "don't hide posts like this" unhides: "${text.slice(0, 50)}"`);
  await sw.evaluate(() => chrome.storage.local.remove("examples"));
}

// Image model latency, measured inside the extension's offscreen document.
const bench = await sw.evaluate(async () => {
  const t = [];
  for (const img of ["landscape.jpg", "code.jpg", "chart.jpg"]) {
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      await chrome.runtime.sendMessage({
        type: "offscreen-classify",
        post: { id: `b${img}${i}`, author: "x", text: "", imageUrls: [`https://pbs.twimg.com/media/${img}?bench=${i}`], hasLink: false, hasMedia: true },
        examples: { hide: [], keep: [] },
        settings: { enabled: true, strictness: "balanced", goals: [], allowAccounts: [], hideStyle: "collapse", onboarded: true, categories: { sexualised: true, clickbait: false, politics: false, gossip: false, offgoal: false } },
      });
      t.push(performance.now() - s);
    }
  }
  return t;
});
const sorted = [...bench].sort((a, b) => a - b);
console.log(`  Image check (fetch + AI model) in browser: median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, min ${sorted[0].toFixed(0)} ms`);
await r1.page.close();

// 2) Off-goal mode with goals.
const r2 = await runFeed(
  "Off-goal only, goals: Learning to code + Fitness & strength",
  { ...base, categories: { sexualised: false, clickbait: false, politics: false, gossip: false, offgoal: true }, goals: ["Learning to code", "Fitness & strength"] },
  (p) => (p.goal ? "shown" : "hidden"),
);
await r2.page.close();

// 3) Blur style screenshot + disabled state.
const r3 = await runFeed("Blur style", { ...base, hideStyle: "blur" }, (p) => (p.expect === "show" ? "shown" : "hidden"));
if (screens) await r3.page.screenshot({ path: join(outDir, "feed-blur.png"), fullPage: true });
await r3.page.close();

await setSettings({ ...base, enabled: false });
const p4 = await ctx.newPage();
await p4.addInitScript((posts) => (window.__POSTS__ = posts), POSTS);
await p4.goto("https://x.com/home");
await p4.waitForTimeout(1500);
const hiddenWhenOff = await p4.locator('article[data-smf="hidden"]').count();
assert.equal(hiddenWhenOff, 0, "nothing hidden when disabled");
console.log("\n  ✓ Nothing hidden when the extension is switched off");
await p4.close();

if (screens) {
  await setSettings({ ...base, onboarded: false, goals: ["Learning to code"], categories: { ...base.categories, offgoal: true } });
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 900, height: 1500 });
  await opt.goto(`chrome-extension://${extId}/options.html?onboarding=1`);
  await opt.waitForTimeout(500);
  await opt.screenshot({ path: join(outDir, "onboarding.png"), fullPage: true });
  await setSettings(base);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 300, height: 330 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(500);
  await pop.screenshot({ path: join(outDir, "popup.png") });
}

const errors = logs.filter((l) => /^\[(page )?(error|warning)\]/.test(l));
if (errors.length) console.log("\nConsole errors:\n" + errors.slice(0, 10).join("\n"));
await ctx.close();
