// Builds the Mac app. If the updater signing key is in ~/.tauri (see README), the build also writes signed
// update files; without it, the app builds the same way minus those files. The key is never printed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = path.join(os.homedir(), ".tauri", "second-name-updater.key");
const env = { ...process.env };
const args = ["tauri", "build", ...process.argv.slice(2)];
if (!env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(key)) {
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(key, "utf8");
  if (fs.existsSync(key + ".password")) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.readFileSync(key + ".password", "utf8").trim();
}
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log("No updater signing key found; building without update files.");
  args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}
const r = spawnSync("npx", args, { stdio: "inherit", env });
process.exit(r.status ?? 1);
