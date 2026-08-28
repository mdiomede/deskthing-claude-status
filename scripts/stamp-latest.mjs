// Copy the versioned build artifacts to stable filenames.
//
// DeskThing's installer (appInstaller.ts) treats a non-http updateUrl as a
// local path and copyFile()s it, so updateUrl can point at a file on disk.
// But the packaged zip is named with the version, so the path would go stale
// on every bump. Stamping a fixed name keeps one URL valid forever.

import { copyFile, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const manifest = JSON.parse(
  await readFile(join(root, "deskthing", "manifest.json"), "utf-8")
);
const stableZip = join(dist, `${manifest.id}-latest.zip`);

const files = await readdir(dist);
const versioned = files.find((f) => f.endsWith(".zip") && f !== `${manifest.id}-latest.zip`);

if (!versioned) {
  console.error("[stamp-latest] no versioned zip found in dist/");
  process.exit(1);
}

await copyFile(join(dist, versioned), stableZip);
console.log(`[stamp-latest] ${versioned} -> ${manifest.id}-latest.zip`);
console.log(`[stamp-latest] updateUrl target: ${stableZip}`);
