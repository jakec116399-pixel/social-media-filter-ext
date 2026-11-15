// Chrome: service worker. The AI models run in an offscreen document, because
// service workers can't use the DOM/WebGL features the models need.
import { ext } from "../shared/ext";
import type { Msg, Verdict } from "../shared/types";
import { startBackground } from "./core";

let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  if (await ext.offscreen.hasDocument()) return;
  if (!creating) {
    creating = ext.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [ext.offscreen.Reason.WORKERS],
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
      return (await ext.runtime.sendMessage(msg)) as T;
    } catch (e) {
      if (attempt >= 50 || !String(e).includes("Receiving end does not exist")) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

startBackground({
  async classify(post, settings, examples) {
    await ensureOffscreen();
    return sendToOffscreen<Verdict>({ type: "offscreen-classify", post, settings, examples });
  },
  async warmup() {
    await ensureOffscreen();
    await sendToOffscreen({ type: "warmup" });
  },
});
