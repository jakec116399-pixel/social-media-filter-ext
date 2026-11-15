# Focus Feed

A Chrome extension that hides unwanted posts from your X (Twitter) feed using AI that runs **on your own device**. Nothing you browse is sent to a server.

It can hide one or more of the following:

| Category | What it catches |
|---|---|
| **Sexualised** | Suggestive or explicit images and text |
| **Clickbait & vagueposts** | Engagement bait, "you won't believe…", cryptic posts with no substance |
| **Politics** | Elections, parties, politicians, culture-war arguments |
| **Celebrity & gossip** | Celebrity drama, relationships, influencer beef |
| **Off-goal** | Anything not related to goals you choose (e.g. "Learning to code", "Fitness") |

Hidden posts collapse to a small bar, or are covered in place, with a **Show anyway** button. Hover over the bar to see why a post was hidden.

### Teach it

Right-click any post → **Focus Feed** →
- **Hide posts like this → (category)** for posts it missed.
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
4. **Text AI** (`src/shared/textModel.ts`, examples in `src/shared/prototypes.ts`). Zero-shot classification. The post is cleaned (links, @mentions and hashtags removed), embedded, and compared with ~20 example posts per category and ~50 neutral posts, averaging the 3 closest matches. Long posts are also scored sentence by sentence. Off-goal compares posts with your goals; preset goals come with example posts. Your right-click examples are added to these sets.
5. **Tier 3, image AI** (`src/offscreen/offscreen.ts`). For posts with images when *Sexualised* is on.
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

| Test set | Unwanted posts caught | Right category | Good posts wrongly hidden |
|---|---|---|---|
| `realistic-posts.json`: messy, real-looking posts, not used to write the examples | 28/34 | 27/28 | 2/24 |
| `labeled-posts.json`: clean examples | 47/50 | 46/47 | 0/34 |

v0.1 balanced caught 23/34 on the realistic set. Real feeds are harder than both sets, which is why teaching by right-click exists.

## Known limitations

- **Desktop Firefox and Chrome-family browsers.** Firefox runs the AI in its background page; Chrome uses an offscreen document. Firefox for Android supports extensions too, but this hasn't been tested there.
- **Video** is judged by its thumbnail, not its frames.
- **Off-goal mode** doesn't hide posts with fewer than 3 words, because there is too little text to judge.
- **Text-based**: it doesn't understand sarcasm or context the way a large language model would.
- X changes its page structure regularly; `x-adapter.ts` may need updates.
