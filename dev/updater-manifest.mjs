// Writes the latest.json read by Vela's updater (tauri-plugin-updater, static JSON format).
// Usage:
//   node dev/updater-manifest.mjs <version> <notes-file> <platforms> <bundle> <download-url> [...] > latest.json
// Each group of three arguments is one update bundle: the updater platform keys it serves
// (comma separated, e.g. "windows-x86_64-nsis,windows-x86_64"), the file on disk and the URL it
// is published at. The bundle's minisign signature (<bundle>.sig, produced by `tauri build` with
// createUpdaterArtifacts) is embedded as-is. A missing notes file gives a default text.
import { existsSync, readFileSync } from "node:fs";

const [version, notesFile, ...bundles] = process.argv.slice(2);
if (!version || !notesFile || bundles.length === 0 || bundles.length % 3 !== 0) {
  console.error(
    "Usage: node dev/updater-manifest.mjs <version> <notes-file> <platforms> <bundle> <download-url> [...]",
  );
  process.exit(1);
}
const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() || `Vela ${version}` : `Vela ${version}`;
// The updater tries "<os>-<arch>-<installer>" first, then "<os>-<arch>".
const platforms = {};
for (let index = 0; index < bundles.length; index += 3) {
  const [keys, bundle, url] = bundles.slice(index, index + 3);
  if (!/^https:\/\//.test(url)) {
    console.error(`Not an HTTPS download URL: ${url}`);
    process.exit(1);
  }
  const signature = readFileSync(`${bundle}.sig`, "utf8").trim();
  for (const key of keys.split(",").filter(Boolean)) {
    if (platforms[key]) {
      console.error(`Platform listed twice: ${key}`);
      process.exit(1);
    }
    platforms[key] = { signature, url };
  }
}
const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
