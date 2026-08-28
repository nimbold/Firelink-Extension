const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const listingPath = path.join(rootDir, "store", "edge", "listing.md");
const listing = fs.readFileSync(listingPath, "utf8");

function pngDimensions(filePath) {
  const data = fs.readFileSync(filePath);
  assert.deepEqual([...data.subarray(0, 8)], [
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a
  ]);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20)
  };
}

test("includes the Edge store artwork at the required dimensions", () => {
  assert.deepEqual(
    pngDimensions(path.join(rootDir, "store", "edge", "assets", "logo-300.png")),
    { width: 300, height: 300 }
  );
  assert.deepEqual(
    pngDimensions(path.join(rootDir, "store", "edge", "assets", "tile-440x280.png")),
    { width: 440, height: 280 }
  );
  assert.ok(fs.existsSync(path.join(rootDir, "store", "edge", "assets", "tile-440x280.svg")));
});

test("keeps six Edge long descriptions complete and localized", () => {
  const sections = [
    ["### English (`en`)", "en"],
    ["### 简体中文 (`zh-CN`, package directory `_locales/zh_CN`)", "zh-CN"],
    ["### עברית (`he`)", "he"],
    ["### فارسی (`fa`)", "fa"],
    ["### Українська (`uk`)", "uk"],
    ["### Русский (`ru`)", "ru"]
  ];

  for (let index = 0; index < sections.length; index += 1) {
    const [heading, locale] = sections[index];
    const start = listing.indexOf(heading);
    const end = index + 1 < sections.length
      ? listing.indexOf("\n### ", start + heading.length)
      : listing.indexOf("\n## Permission and host-access justifications", start + heading.length);

    assert.notEqual(start, -1, `missing ${locale} listing heading`);
    assert.notEqual(end, -1, `missing end of ${locale} listing section`);

    const description = listing
      .slice(start + heading.length, end)
      .trim();

    assert.ok(description.length >= 250, `${locale} description is shorter than 250 characters`);
    assert.ok(!description.includes("TODO"), `${locale} description contains an unfinished placeholder`);
  }
});

test("keeps the privacy and screenshot handoff materials linked", () => {
  assert.ok(fs.existsSync(path.join(rootDir, "PRIVACY.md")));
  assert.match(listing, /https:\/\/github\.com\/nimbold\/Firelink-Extension\/blob\/main\/PRIVACY\.md/);
  assert.match(listing, /screenshots\/README\.md|screenshots\//);
  assert.match(
    fs.readFileSync(path.join(rootDir, "store", "edge", "screenshots", "README.md"), "utf8"),
    /real Microsoft Edge installation/
  );
});

test("keeps the manual release version aligned with the package", () => {
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
  ).version;
  const manifestVersion = JSON.parse(
    fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")
  ).version;
  const releaseWorkflow = fs.readFileSync(
    path.join(rootDir, ".github", "workflows", "release.yml"),
    "utf8"
  );

  assert.equal(manifestVersion, packageVersion);
  assert.match(releaseWorkflow, new RegExp(`^\\s+default: "${packageVersion}"$`, "m"));
});
