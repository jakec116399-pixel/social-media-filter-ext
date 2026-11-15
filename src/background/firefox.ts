// Firefox: background page (has a DOM), so the AI engine runs here directly.
import { classify, warmup } from "../engine/engine";
import { startBackground } from "./core";

startBackground({
  classify,
  async warmup() {
    warmup();
  },
});
warmup();
