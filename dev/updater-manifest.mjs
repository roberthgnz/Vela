// Writes the latest.json read by Vela's updater (tauri-plugin-updater, static JSON format).
// Usage: node dev/updater-manifest.mjs <version> <installer> <download-url> [notes-file] > latest.json
// The installer's minisign signature (<installer>.sig, produced by `tauri build` with
// createUpdaterArtifacts) is embedded as-is.
import { existsSync, readFileSync } from "node:fs";

const [version, installer, url, notesFile] = process.argv.slice(2);
if (!version || !installer || !url) {
  console.error("Usage: node dev/updater-manifest.mjs <version> <installer> <download-url> [notes-file]");
  process.exit(1);
}
const signature = readFileSync(`${installer}.sig`, "utf8").trim();
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : `Vela ${version}`;
const platform = { signature, url };
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  // The updater tries "<os>-<arch>-<installer>" first, then "<os>-<arch>".
  platforms: { "windows-x86_64-nsis": platform, "windows-x86_64": platform },
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
