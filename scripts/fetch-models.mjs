// Downloads the on-device AI model files into public/models so they are
// bundled with the extension (no network calls at runtime).
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const HF = "https://huggingface.co";
const MODELS = [
  {
    id: "Xenova/all-MiniLM-L6-v2",
    revision: "main",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
  },
];

// Extra model ids can be passed on the command line (for comparing models).
for (const id of process.argv.slice(2)) {
  MODELS.push({ id, revision: "main", files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"] });
}

const root = join(import.meta.dirname, "..", "public", "models");

for (const model of MODELS) {
  for (const file of model.files) {
    const dest = join(root, model.id, file);
    try {
      if ((await stat(dest)).size > 0) { console.log(`✓ ${model.id}/${file} (cached)`); continue; }
    } catch {}
    const url = `${HF}/${model.id}/resolve/${model.revision}/${file}`;
    process.stdout.write(`↓ ${model.id}/${file} ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  }
}
