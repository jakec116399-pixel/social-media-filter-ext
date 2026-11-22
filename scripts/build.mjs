// Builds the extension for Chrome and Firefox:
//   dist/chrome   → chrome://extensions → "Load unpacked"
//   dist/firefox  → about:debugging → "Load Temporary Add-on" → pick manifest.json
//   dist/focus-feed-firefox.zip, dist/focus-feed-chrome.zip → packaged versions
// Pass --target=chrome or --target=firefox to build only one.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const only = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
const targets = only ? [only] : ["chrome", "firefox"];

try {
  await stat(join(root, "public/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"));
} catch {
  console.error("Models missing. Run `npm run setup` first.");
  process.exit(1);
}

if (!only) await rm(join(root, "dist"), { recursive: true, force: true });

// Precompute embeddings for the built-in example posts (fast extension startup).
execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/embed-prototypes.ts"], {
  cwd: root,
  stdio: "inherit",
});

const GECKO_ID = "focus-feed@social-media-filter-ext";

for (const target of targets) {
  const dist = join(root, "dist", target);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const common = { bundle: true, minify: true, logLevel: "warning", target: ["chrome120", "firefox128"] };
  const pages = {
    background: target === "chrome" ? "src/background/chrome.ts" : "src/background/firefox.ts",
    options: "src/ui/options.ts",
    popup: "src/ui/popup.ts",
    ...(target === "chrome" ? { offscreen: "src/offscreen/offscreen.ts" } : {}),
  };
  await build({ ...common, entryPoints: { content: "src/content/content.ts" }, outdir: dist, format: "iife" });
  await build({
    ...common,
    entryPoints: pages,
    outdir: dist,
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    // Node-only modules referenced by the AI libraries but never used in the browser.
    external: ["fs", "path", "url", "sharp", "onnxruntime-node", "node:*"],
  });

  // Copy static files, but only the model the extension uses (public/models may
  // also hold models downloaded for comparison with `npm run eval`).
  const SHIPPED_MODEL = "Xenova/all-MiniLM-L6-v2";
  await cp(join(root, "public"), dist, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(join(root, "public").length).replaceAll("\\", "/");
      if (!rel.startsWith("/models/")) return true;
      const id = rel.slice("/models/".length);
      return SHIPPED_MODEL.startsWith(id) || id.startsWith(SHIPPED_MODEL);
    },
  });
  const ort = join(root, "node_modules/onnxruntime-web/dist");
  await mkdir(join(dist, "ort"), { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
    await cp(join(ort, f), join(dist, "ort", f));
  }

  const manifest = JSON.parse(await readFile(join(root, "public/manifest.json"), "utf8"));
  if (target === "firefox") {
    // Firefox has no offscreen documents; the background page runs the AI engine itself.
    manifest.background = { page: "background.html" };
    manifest.permissions = manifest.permissions.filter((p) => p !== "offscreen");
    manifest.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
      gecko_android: { strict_min_version: "142.0" },
    };
    await rm(join(dist, "offscreen.html"));
    await writeFile(
      join(dist, "background.html"),
      '<!doctype html>\n<html><head><meta charset="utf-8"></head><body><script type="module" src="background.js"></script></body></html>\n',
    );
  } else {
    await rm(join(dist, "background.html"), { force: true });
  }
  await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

  const zip = join(root, "dist", `focus-feed-${target}.zip`);
  await rm(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "."], { cwd: dist });
  console.log(`Built dist/${target}/ and dist/focus-feed-${target}.zip`);
}
