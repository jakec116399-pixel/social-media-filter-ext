// Chrome offscreen document: hosts the AI engine and answers the service worker.
import { classify, engineInfo, warmup } from "../engine/engine";
import { ext } from "../shared/ext";
import type { Msg } from "../shared/types";

ext.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === "offscreen-classify") {
    classify(msg.post, msg.settings, msg.examples)
      .then(sendResponse)
      .catch((e) => sendResponse({ hide: false, scores: {}, ms: 0, error: String(e) }));
    return true;
  }
  if (msg.type === "engine-info") {
    sendResponse(engineInfo());
    return false;
  }
  if (msg.type === "warmup") warmup();
  return false;
});

warmup();
