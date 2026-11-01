// Points src-tauri/libmpv.json at a current LGPL libmpv build.
//
//   node dev/update-libmpv.mjs            show what the latest build would put in the manifest
//   node dev/update-libmpv.mjs --write    write it to src-tauri/libmpv.json
//   node dev/update-libmpv.mjs --mirror   also upload the archive, unchanged, to a release of this
//                                         repository (tag libmpv-<version>); publishes: run it only
//                                         when you mean to
//
// The upstream builds (zhongfly/mpv-winbuild) are kept for 30 days, so the manifest lists a copy in
// this repository first and the upstream address second. Vela accepts a download only if its size
// and SHA-256 are the ones pinned here, so neither host has to be trusted. Needs the GitHub CLI.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = "zhongfly/mpv-winbuild";
const mirror = "roberthgnz/Vela";
const manifestPath = fileURLToPath(new URL("../src-tauri/libmpv.json", import.meta.url));
const args = new Set(process.argv.slice(2));

const gh = (...parameters) => execFileSync("gh", parameters, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const release = JSON.parse(gh("api", `repos/${upstream}/releases/latest`));
const asset = release.assets.find((item) => /^mpv-dev-lgpl-x86_64-\d{8}-git-[0-9a-f]+\.7z$/.test(item.name));
if (!asset) throw new Error(`No LGPL x86_64 libmpv archive in ${upstream} ${release.tag_name}.`);
const [, date, commit] = /-(\d{8})-git-([0-9a-f]+)\.7z$/.exec(asset.name);
const version = `${date}-${commit}`;
const sha256 = asset.digest?.replace(/^sha256:/, "");
if (!sha256 || sha256.length !== 64) throw new Error("GitHub did not report a SHA-256 digest for the asset.");

const manifest = {
  version,
  sha256,
  size: asset.size,
  entry: "libmpv-2.dll",
  license: "LGPL-2.1-or-later",
  source: `https://github.com/${upstream}`,
  urls: [`https://github.com/${mirror}/releases/download/libmpv-${version}/${asset.name}`, asset.browser_download_url],
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;
const current = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(text);
console.log(current.version === version ? "The manifest already points at this build." : `The manifest has ${current.version}.`);

if (args.has("--mirror")) {
  const folder = mkdtempSync(join(tmpdir(), "libmpv-"));
  const file = join(folder, asset.name);
  gh("release", "download", release.tag_name, "--repo", upstream, "--pattern", asset.name, "--dir", folder);
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== sha256) throw new Error(`The downloaded archive is ${actual}, not ${sha256}.`);
  gh(
    "release", "create", `libmpv-${version}`, file,
    "--repo", mirror,
    "--title", `libmpv ${version}`,
    "--notes",
    `Unmodified copy of ${asset.name} from ${manifest.source}/releases/tag/${release.tag_name} (LGPL-2.1-or-later build; sources and build scripts at the upstream repository). SHA-256 ${sha256}. Vela downloads it only when the user asks for embedded mpv.`,
  );
  console.log(`Published libmpv-${version} in ${mirror}.`);
}
if (args.has("--write")) {
  writeFileSync(manifestPath, text);
  console.log(`Wrote ${manifestPath}.`);
}
