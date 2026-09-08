const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildPackages,
  chromiumManifest
} = require("../scripts/package-extension.js");

const rootDir = path.resolve(__dirname, "..");
const localeDirectories = ["en", "zh_CN", "he", "fa", "uk", "ru"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("uses Chromium localization metadata for all supported languages", () => {
  const manifest = readJson(path.join(rootDir, "manifest.json"));

  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  assert.equal(manifest.default_locale, "en");

  for (const locale of localeDirectories) {
    const messages = readJson(path.join(rootDir, "_locales", locale, "messages.json"));

    assert.equal(messages.extensionName.message, "Firelink Companion");
    assert.ok(messages.extensionDescription.message.length <= 132);
    assert.ok(messages.extensionDescription.message.length >= 20);
  }
});

test("generates a Chromium Manifest V3 service worker manifest", () => {
  const manifest = chromiumManifest();

  assert.deepEqual(manifest.background, {
    service_worker: "chromium-service-worker.js"
  });
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("cookies"));
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);
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
      scripts: ["protocol.js", "popup/locales.js", "background.js"]
    });
    assert.equal(firefoxManifest.browser_specific_settings.gecko.id, "firelink@nimbold.github.io");
    assert.deepEqual(chromiumManifest.background, {
      service_worker: "chromium-service-worker.js"
    });
    assert.equal(firefoxManifest.content_scripts[0].match_origin_as_fallback, true);
    assert.equal(chromiumManifest.content_scripts[0].match_origin_as_fallback, true);
    assert.equal(chromiumManifest.default_locale, "en");
    assert.equal(chromiumManifest.name, "__MSG_extensionName__");
    assert.equal(chromiumManifest.description, "__MSG_extensionDescription__");
    assert.equal(
      fs.readFileSync(path.join(outputRoot, "chromium", "chromium-service-worker.js"), "utf8").trim(),
      'importScripts("protocol.js", "popup/locales.js", "background.js");'
    );
    assert.ok(fs.existsSync(path.join(outputRoot, "firefox", "popup", "locales.js")));
    assert.ok(fs.existsSync(path.join(outputRoot, "chromium", "popup", "locales.js")));

    for (const packageName of ["firefox", "chromium"]) {
      for (const locale of localeDirectories) {
        const messagesPath = path.join(outputRoot, packageName, "_locales", locale, "messages.json");
        assert.ok(fs.existsSync(messagesPath), `${packageName} package is missing ${locale} messages`);
        assert.equal(readJson(messagesPath).extensionName.message, "Firelink Companion");
      }
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
