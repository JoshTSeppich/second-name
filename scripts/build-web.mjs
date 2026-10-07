// Copies the web app into dist/ for the Tauri shell: only what the app needs, never node_modules, tests or data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const FILES = ["index.html", "manifest.webmanifest", "sw.js", "icons", "venues"];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(DIST, f), { recursive: true });
console.log(`web app copied to ${path.relative(ROOT, DIST)}/: ${FILES.join(", ")}`);
