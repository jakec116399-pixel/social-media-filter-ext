// Precomputes embeddings for all built-in example posts and goal presets, so
// the extension doesn't have to embed them every time it starts.
// Output: public/prototype-vectors.json (run automatically by `npm run build`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import { fixedTexts, type PrecomputedFile } from "../src/shared/textModel.ts";

const root = join(import.meta.dirname, "..");
env.allowRemoteModels = false;
env.localModelPath = join(root, "public", "models") + "/";
const MODEL = "Xenova/all-MiniLM-L6-v2";

const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
const texts = fixedTexts();
const out = await extractor(texts, { pooling: "mean", normalize: true });
const data = new Float32Array(out.data as Float32Array);
const file: PrecomputedFile = {
  model: MODEL,
  dim: out.dims[1],
  texts,
  data: Buffer.from(data.buffer).toString("base64"),
};
writeFileSync(join(root, "public", "prototype-vectors.json"), JSON.stringify(file));
console.log(`Embedded ${texts.length} example texts → public/prototype-vectors.json`);
