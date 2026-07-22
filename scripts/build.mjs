import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "web-ext-artifacts");
const sourceManifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
const version = sourceManifest.version;
const runtimeEntries = [
  "background",
  "content",
  "icons",
  "images",
  "popup",
  "shared",
  "manifest.json",
  "rules.json",
];

function assertGeneratedPath(target) {
  const relative = path.relative(outputRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify a path outside web-ext-artifacts: ${target}`);
  }
}

async function resetDirectory(target) {
  assertGeneratedPath(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

async function copyRuntime(target) {
  for (const entry of runtimeEntries) {
    await cp(path.join(projectRoot, entry), path.join(target, entry), { recursive: true });
  }
}

async function writeManifest(target, manifest) {
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createArchive(sourceDirectory, archivePath) {
  assertGeneratedPath(archivePath);
  execFileSync("zip", ["-X", "-r", "-FS", archivePath, "."], {
    cwd: sourceDirectory,
    stdio: "inherit",
  });
}

await mkdir(outputRoot, { recursive: true });

const firefoxDirectory = path.join(outputRoot, `firefox-${version}`);
await resetDirectory(firefoxDirectory);
await copyRuntime(firefoxDirectory);
const firefoxManifest = structuredClone(sourceManifest);
await writeManifest(firefoxDirectory, firefoxManifest);
const firefoxArchive = path.join(outputRoot, `commentsync-title-row-${version}-firefox.xpi`);
await rm(firefoxArchive, { force: true });
createArchive(firefoxDirectory, firefoxArchive);

const chromeDirectory = path.join(outputRoot, `chrome-${version}`);
await resetDirectory(chromeDirectory);
await copyRuntime(chromeDirectory);
const chromeManifest = structuredClone(sourceManifest);
delete chromeManifest.browser_specific_settings;
chromeManifest.background = {
  service_worker: "background/background.js",
  type: "module",
};
await writeManifest(chromeDirectory, chromeManifest);
const chromeArchive = path.join(outputRoot, `commentsync-title-row-${version}-chrome.zip`);
await rm(chromeArchive, { force: true });
createArchive(chromeDirectory, chromeArchive);

console.log(`Built Firefox ${version}: ${firefoxArchive}`);
console.log(`Built Chrome ${version}: ${chromeArchive}`);
