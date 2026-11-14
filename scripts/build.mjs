// Builds the extension into dist/ (load it in Chrome via chrome://extensions → "Load unpacked").
import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

try {
  await stat(join(root, "public/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"));
} catch {
  console.error("Models missing. Run `npm run setup` first.");
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, target: "chrome120", minify: !watch, sourcemap: watch ? "inline" : false, logLevel: "info" };
await Promise.all([
  build({ ...common, entryPoints: { content: "src/content/content.ts" }, outdir: dist, format: "iife" }),
  build({
    ...common,
    entryPoints: {
      background: "src/background/background.ts",
      offscreen: "src/offscreen/offscreen.ts",
      options: "src/ui/options.ts",
      popup: "src/ui/popup.ts",
    },
    outdir: dist,
    format: "esm",
    // Node-only modules referenced by the AI libraries but never used in the browser.
    external: ["fs", "path", "url", "sharp", "onnxruntime-node", "node:*"],
  }),
]);

await cp(join(root, "public"), dist, { recursive: true });
const ort = join(root, "node_modules/onnxruntime-web/dist");
await mkdir(join(dist, "ort"), { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  await cp(join(ort, f), join(dist, "ort", f));
}
console.log("Built to dist/");
