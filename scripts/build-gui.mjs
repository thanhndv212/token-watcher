/**
 * Build script for the Electron menubar GUI app.
 *
 * This script copies renderer files (HTML, CSS, JS) to dist/gui/renderer/.
 * The renderer itself is plain vanilla JS/DOM (src/gui/renderer/) —
 * no framework, no bundler needed.
 *
 * Run: node scripts/build-gui.mjs
 */

import { cp, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const srcDir = join(rootDir, "src", "gui");
const distDir = join(rootDir, "dist", "gui");
const rendererSrc = join(srcDir, "renderer");
const rendererDist = join(distDir, "renderer");

async function main() {
  console.log("Building GUI renderer...");

  await mkdir(rendererDist, { recursive: true });

  // Electron requires an .mjs extension to load an ESM preload. The compiler
  // emits .js, which Electron would otherwise interpret as CommonJS.
  await cp(join(distDir, "preload.js"), join(distDir, "preload.mjs"));

  // index.html loads lib/*.js, views/*.js and app.js as classic scripts, so the
  // whole renderer tree is copied as-is.
  console.log("  Copying renderer (HTML, CSS, lib/, views/, app.js)...");
  await cp(rendererSrc, rendererDist, { recursive: true });

  console.log("GUI renderer build complete!");
  console.log(`  Output: ${rendererDist}`);
}

main().catch((err) => {
  console.error("GUI build failed:", err);
  process.exit(1);
});
