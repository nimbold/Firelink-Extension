const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildPackages,
  chromiumManifest
} = require("../scripts/package-extension.js");

test("generates a Chromium Manifest V3 service worker manifest", () => {
  const manifest = chromiumManifest();

  assert.deepEqual(manifest.background, {
    service_worker: "chromium-service-worker.js"
  });
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("cookies"));
});

test("packages Firefox and Chromium load-unpacked directories", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "firelink-extension-"));

  try {
    buildPackages(outputRoot);

    const firefoxManifest = JSON.parse(
      fs.readFileSync(path.join(outputRoot, "firefox", "manifest.json"), "utf8")
    );
    const chromiumManifest = JSON.parse(
      fs.readFileSync(path.join(outputRoot, "chromium", "manifest.json"), "utf8")
    );

    assert.deepEqual(firefoxManifest.background, {
      scripts: ["protocol.js", "background.js"]
    });
    assert.equal(firefoxManifest.browser_specific_settings.gecko.id, "firelink@nimbold.github.io");
    assert.deepEqual(chromiumManifest.background, {
      service_worker: "chromium-service-worker.js"
    });
    assert.equal(
      fs.readFileSync(path.join(outputRoot, "chromium", "chromium-service-worker.js"), "utf8").trim(),
      'importScripts("protocol.js", "background.js");'
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
