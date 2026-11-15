// Scroll-performance test: a long mock X feed that mutates constantly (like the
// real site), measuring how much main-thread time the content script uses.
//   npm run build && node scripts/perf.mjs
import { chromium } from "playwright";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist", "chrome");
const fixture = await readFile(join(root, "tests/fixtures/x-home.html"), "utf8");

const texts = [
  "The Senate passed the bill late last night after a long debate",
  "New photoshoot is too hot for here 🔥 link in bio",
  "Quick tip: use git stash -p to stash part of your changes",
  "The pop star and her boyfriend reportedly split",
  "some people really think they're untouchable lol",
  "Hit a new deadlift PR today 💪",
  "Sunrise from the summit this morning",
  "Only 2% of people can solve this. Can you?",
];
const POSTS = Array.from({ length: 150 }, (_, i) => ({
  user: `user${i}`,
  name: `User ${i}`,
  text: `${texts[i % texts.length]} #${i}`,
}));

const profile = join(root, ".e2e-profile");
await rm(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  viewport: { width: 1000, height: 1000 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
await ctx.route("https://x.com/**", (r) =>
  r.request().resourceType() === "document" ? r.fulfill({ contentType: "text/html", body: fixture }) : r.fulfill({ status: 404 }),
);
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");

for (const strictness of ["balanced", "strict"]) {
  await sw.evaluate(
    (st) =>
      chrome.storage.sync.set({
        settings: {
          enabled: true, onboarded: true, strictness: st, hideStyle: "collapse", allowAccounts: [], goals: [],
          categories: { sexualised: true, clickbait: true, politics: true, gossip: true, offgoal: false },
        },
      }),
    strictness,
  );
  const page = await ctx.newPage();
  await page.addInitScript((posts) => {
    window.__POSTS__ = posts;
    // Mimic X: constant small DOM updates (counters, timestamps, video players).
    setInterval(() => {
      document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach((c, i) => {
        if (i % 3) return;
        const s = c.querySelector(".actions span");
        if (s) s.textContent = String(Math.random()).slice(2, 5);
        const tick = document.createElement("i");
        c.append(tick);
        tick.remove();
      });
    }, 50);
  }, POSTS);
  await page.goto("https://x.com/home");
  await page.evaluate(() => (document.documentElement.dataset.smfDebug = ""));
  await page.waitForFunction(() => document.querySelectorAll('article[data-smf="ok"],article[data-smf="hidden"]').length >= 150, null, { timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.smfPerf);
  const before = await page.evaluate(() => document.documentElement.dataset.smfPerf);
  // Scroll for 5 seconds while measuring long frames.
  const frames = await page.evaluate(async () => {
    const gaps = [];
    let last = performance.now();
    const end = last + 5000;
    while (performance.now() < end) {
      window.scrollBy(0, 40);
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }
    return gaps;
  });
  const after = await page.evaluate(() => document.documentElement.dataset.smfPerf);
  const [s0, m0] = before.split(":").map(Number);
  const [s1, m1] = after.split(":").map(Number);
  const hidden = await page.locator('article[data-smf="hidden"]').count();
  const slow = frames.filter((g) => g > 33).length;
  console.log(
    `${strictness.padEnd(9)} hidden ${hidden}/150 | during 5s scroll: ${s1 - s0} scans, ${(m1 - m0).toFixed(0)} ms of extension work, ` +
      `${(((m1 - m0) / 5000) * 100).toFixed(1)}% of main thread | ${frames.length} frames, ${slow} slow (>33ms)`,
  );
  await page.close();
}
await ctx.close();
