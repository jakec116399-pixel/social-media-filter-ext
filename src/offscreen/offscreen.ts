// Chrome offscreen document: hosts the AI engine and answers the service worker.
import { classify, warmup } from "../engine/engine";
import { ext } from "../shared/ext";
import type { Msg } from "../shared/types";

ext.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === "offscreen-classify") {
    classify(msg.post, msg.settings)
      .then(sendResponse)
      .catch((e) => sendResponse({ hide: false, scores: {}, ms: 0, error: String(e) }));
    return true;
  }
  if (msg.type === "warmup") warmup();
  return false;
});

warmup();
