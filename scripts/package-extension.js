const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

const sharedEntries = [
  "background.js",
  "content.js",
  "icons",
  "popup",
  "protocol.js"
];

function copyEntry(sourceRoot, destinationRoot, entry) {
  const source = path.join(sourceRoot, entry);
  const destination = path.join(destinationRoot, entry);
  fs.cpSync(source, destination, { recursive: true });
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
}

function writeManifest(destinationRoot, manifest) {
  fs.writeFileSync(
    path.join(destinationRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function buildFirefoxPackage(outputRoot) {
  const destination = path.join(outputRoot, "firefox");
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of sharedEntries) {
    copyEntry(rootDir, destination, entry);
  }
  writeManifest(destination, readManifest());
}

function chromiumManifest() {
  const manifest = readManifest();
  delete manifest.browser_specific_settings;
  manifest.background = {
    service_worker: "chromium-service-worker.js"
  };
  return manifest;
}

function buildChromiumPackage(outputRoot) {
  const destination = path.join(outputRoot, "chromium");
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of sharedEntries) {
    copyEntry(rootDir, destination, entry);
  }
  copyEntry(rootDir, destination, "chromium-service-worker.js");
  writeManifest(destination, chromiumManifest());
}

function buildPackages(outputRoot = path.join(rootDir, "dist")) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  buildFirefoxPackage(outputRoot);
  buildChromiumPackage(outputRoot);
  return outputRoot;
}

if (require.main === module) {
  const outputRoot = buildPackages();
  console.log(`Packaged extension builds in ${path.relative(rootDir, outputRoot)}`);
}

module.exports = {
  buildPackages,
  chromiumManifest
};
