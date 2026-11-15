# Focus Feed

A Chrome extension that hides unwanted posts from your X (Twitter) feed using AI that runs **on your own device**. Nothing you browse is sent to a server.

Every post gets labels in three groups, and you choose which labels hide a post:

| Group | Labels |
|---|---|
| **Safety** | Sexualised (text and images) |
| **Topics**: what a post is about | Politics · News & events · Celebrity & gossip · Sports · Film, TV, music & gaming · Memes & humour · Money, crypto & hustle · Tech & science · Learning & education · Health & fitness · Food, travel & lifestyle · Personal updates · Relationships & dating · Ads & promotion |
| **Tone**: how it's written | Rage bait · Engagement bait · Vagueposting · Doom & negativity · Trend formats ("> be me" greentext, "POV:", "nobody: / me:", "tell me … without telling me", starter packs…) |
| **Goal mode** | Off-goal: hide anything unrelated to goals you choose (e.g. "Learning to code") |

A post can have several labels, such as "Politics · Rage bait", so you can, for example, keep politics but hide rage bait.

Hidden posts collapse to a small bar, or are covered in place, with a **Show anyway** button. Hover over the bar to see why a post was hidden.

### Teach it

**On posts you chose to show:** a quiet line stays under the post, "Hidden as Politics · Rage bait · Right? ✓ ✗". ✓ reinforces the label. ✗ lets you pick the correct topic or tone, or say "don't hide posts like this".

**On any post:** 
right-click → **Focus Feed** →
- **Hide posts about… → (topic)** or **Hide posts written like this… → (tone)** for posts it missed. This also switches that label on.
- **Don't hide posts like this** for posts it hid by mistake.

It learns immediately, on your device. Similar posts follow your choice from then on, and your examples sharpen each category. The popup shows how many posts you've taught and can forget them. **Copy feedback report** copies recent decisions and their scores, which is useful for tuning the built-in thresholds.

## Try it

No developer account is needed to try it on your own computer.

### Firefox (temporary, until Firefox restarts)

1. Download `focus-feed-firefox.zip` and unzip it.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose the `manifest.json` file in the unzipped folder.
4. The setup page opens. If it shows **Allow access to X**, click it and accept. Then pick your categories and goals and click **Save**.
5. Open https://x.com/home and scroll.

Firefox removes temporary add-ons when it restarts. To keep it installed, the extension has to be signed by Mozilla (see below).

### Chrome / Edge / Brave

1. Unzip `focus-feed-chrome.zip`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.

### Building from source

```bash
npm install
npm run setup   # downloads the text AI model (~23 MB) into public/models
npm run build   # builds dist/chrome, dist/firefox and a .zip of each
```

### Installing permanently on Firefox

Normal Firefox only keeps extensions signed by Mozilla. Signing is free:

1. Create a free account at https://addons.mozilla.org.
2. Under **Developer Hub → Submit a New Add-on**, choose **On your own** (unlisted, so it isn't public) and upload `focus-feed-firefox.zip`.
3. Mozilla signs it automatically, usually within minutes. Download the signed `.xpi` and open it in Firefox to install.

### Lock (strict mode)

With strictness set to **Strict**, you can tick **Lock hidden posts**. Hidden posts then show 🔒 with no "Show anyway", and can't be taught back into the feed. It can still be turned off in settings.

## How it works

```
X page ──► content script ─── keyword rules (instant) ──► hide / show
              │
              └─► background ──► AI engine (Chrome: offscreen document; Firefox: background page)
                                          ├─ text: MiniLM sentence embeddings (~3 ms/post)
                                          └─ images: NSFWJS MobileNetV2 (~100–200 ms/image)
```

1. **Find posts.** `src/content/x-adapter.ts` knows X's page structure. When X changes its markup, this is the only file to update.
2. **Blur while checking.** New posts are blurred until judged, so nothing flashes on screen.
3. **Keywords** (`src/shared/heuristics.ts`). High-precision rules for obvious cases.
4. **Text AI** (`src/shared/textModel.ts`; example posts in `src/shared/prototypes.ts`). The post is cleaned (links, @mentions and hashtags removed), embedded, and compared with example posts for every label, averaging the 3 closest matches. **Topics compete**: a post's topic is the one it's closest to, so topics nobody hides still give every post a sensible home instead of forcing it into the nearest hidden category. **Tones** are judged separately, against plainly written posts. Long posts are also scored sentence by sentence. Embeddings of the built-in examples are precomputed at build time (`scripts/embed-prototypes.ts`) for fast startup. Your right-click examples are added to the sets.
5. **Image AI** (`src/engine/engine.ts`, rules in `src/shared/imagePolicy.ts`). NSFWJS MobileNetV2 checks photos and video thumbnails when Sexualised is on. Explicit content (Porn/Hentai) hides at moderate confidence. The broad "Sexy" class only hides at very high confidence, because it also fires on face close-ups and dark frames. Video thumbnails need more confidence, and the post's text is used as context: clearly about another topic means a higher bar, sexualised text means a lower one.
6. **Cache.** Results are cached per post, text and image URL.

## Development

| Command | What it does |
|---|---|
| `npm run build` | Build to `dist/` |
| `npm test` | Unit tests |
| `npm run eval` | Text-filter accuracy on `tests/data/labeled-posts.json` (`-- --mistakes` lists errors) |
| `npm run e2e` | Loads the Chrome build in Chromium against a mock X feed and checks which posts are hidden (`-- --screens` saves screenshots to `test-results/`) |
| `npm run perf` | Scroll-performance test on a 150-post mock feed that changes constantly |
| `npm run typecheck` | TypeScript check |

### Current accuracy (balanced setting)

Measured with `npm run eval` on posts that were **not** used to write the examples:

| | `realistic-posts.json` (58 messy posts) | `topic-posts.json` (78 posts, all topics) |
|---|---|---|
| Closest topic correct | 84% | 89% |
| Typical user* — unwanted posts hidden | 31/34 | 17/20 |
| Typical user* — good posts wrongly hidden | 2/24 | 2/58 |
| Tones found / false tone labels | 11/15 / 3 | 8/12 / 6 |

\*Hides sexualised, politics, gossip, rage bait, engagement bait and vagueposting.

Tone is harder than topic: rage bait in particular is often missed. Both sets are small and hand-written, so real feeds will be harder. Teaching by right-click is the main way to fix your specific feed.

## Known limitations

- **Desktop Firefox and Chrome-family browsers.** Firefox runs the AI in its background page; Chrome uses an offscreen document. Firefox for Android supports extensions too, but this hasn't been tested there.
- **Video** is judged by its thumbnail, not its frames.
- **Off-goal mode** doesn't hide posts with fewer than 3 words, because there is too little text to judge.
- **Text-based**: it doesn't understand sarcasm or context the way a large language model would.
- X changes its page structure regularly; `x-adapter.ts` may need updates.
