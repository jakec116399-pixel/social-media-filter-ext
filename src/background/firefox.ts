// Firefox: background page (has a DOM), so the AI engine runs here directly.
import { classify, engineInfo, warmup } from "../engine/engine";
import { startBackground } from "./core";

startBackground({
  classify,
  async warmup() {
    warmup();
  },
  async info() {
    return engineInfo();
  },
});
warmup();
