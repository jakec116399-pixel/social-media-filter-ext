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

Hidden posts collapse to a small bar, or blur in place, with a **Show anyway** button.

## Try it

```bash
npm install
npm run setup   # downloads the text AI model (~23 MB) into public/models
npm run build   # builds the extension into dist/
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. The setup page opens. Pick your categories and goals, then click **Save**.
5. Open https://x.com/home and scroll.

## How it works

```
X page ──► content script ─── keyword rules (instant) ──► hide / show
              │
              └─► background worker ──► offscreen document (AI models)
                                          ├─ text: MiniLM sentence embeddings (~3 ms/post)
                                          └─ images: NSFWJS MobileNetV2 (~100–200 ms/image)
```

1. **Find posts.** `src/content/x-adapter.ts` knows X's page structure. When X changes its markup, this is the only file to update.
2. **Blur while checking.** New posts are blurred until judged, so nothing flashes on screen.
3. **Tier 1, keywords** (`src/shared/heuristics.ts`). Obvious cases are decided instantly.
4. **Tier 2, text AI** (`src/shared/textModel.ts`). Zero-shot classification: each post is compared with example posts for each category and with neutral posts. Off-goal compares posts with your goals; preset goals come with example posts for better matching.
5. **Tier 3, image AI** (`src/offscreen/offscreen.ts`). For posts with images when *Sexualised* is on.
6. **Cache.** Results are cached per post, text and image URL.

## Development

| Command | What it does |
|---|---|
| `npm run build` | Build to `dist/` |
| `npm test` | Unit tests |
| `npm run eval` | Text-filter accuracy on `tests/data/labeled-posts.json` (`-- --mistakes` lists errors) |
| `npm run e2e` | Loads the built extension in Chromium against a mock X feed and checks which posts are hidden (`-- --screens` saves screenshots to `test-results/`) |
| `npm run typecheck` | TypeScript check |

### Current accuracy (balanced setting)

- Text eval set (84 posts): **98%** correct; off-goal 32/34.
- End-to-end mock feed (12 unseen posts): 12/12 in all three scenarios.

These sets are small and hand-written, so treat them as a smoke test. Real-world accuracy will be lower. Collecting real mistakes from "Show anyway" clicks is the next step.

## Known limitations

- **Desktop Chrome (and Chromium browsers) only** for now. Firefox needs a small change, because it has no offscreen documents.
- **Video** is judged by its thumbnail, not its frames.
- **Off-goal mode** doesn't hide posts with fewer than 3 words, because there is too little text to judge.
- **Text-based**: it doesn't understand sarcasm or context the way a large language model would.
- X changes its page structure regularly; `x-adapter.ts` may need updates.
