const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const popupI18n = require("../popup/locales.js");

test("matches Firelink's supported locale and theme sets", () => {
  assert.deepEqual(popupI18n.localeCodes, ["en", "zh-CN", "he", "fa", "uk", "ru"]);
  assert.deepEqual(popupI18n.languagePreferences, ["system", "en", "zh-CN", "he", "fa", "uk", "ru"]);
  assert.deepEqual(popupI18n.themes, ["system", "light", "dark", "dracula", "nord"]);
  assert.equal(popupI18n.catalogs.he.direction, "rtl");
  assert.equal(popupI18n.catalogs.fa.direction, "rtl");
  assert.equal(popupI18n.catalogs.uk.direction, "ltr");
});

test("resolves browser language tags like the desktop app", () => {
  assert.equal(popupI18n.resolveLocale("en-US"), "en");
  assert.equal(popupI18n.resolveLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(popupI18n.resolveLocale("iw-IL"), "he");
  assert.equal(popupI18n.resolveLocale("fa-IR"), "fa");
  assert.equal(popupI18n.resolveLocale("uk-UA"), "uk");
  assert.equal(popupI18n.resolveLocale("ru-RU"), "ru");
  assert.equal(popupI18n.resolveLocale("de-DE"), "en");
});

test("guards persisted language and theme values", () => {
  assert.equal(popupI18n.normalizeLanguagePreference("fa"), "fa");
  assert.equal(popupI18n.normalizeLanguagePreference("not-a-locale"), "system");
  assert.equal(popupI18n.normalizeTheme("dracula"), "dracula");
  assert.equal(popupI18n.normalizeTheme("not-a-theme"), "system");
});

test("keeps every popup catalog structurally identical", () => {
  const englishKeys = Object.keys(popupI18n.catalogs.en).sort();
  for (const locale of popupI18n.localeCodes) {
    assert.deepEqual(Object.keys(popupI18n.catalogs[locale]).sort(), englishKeys, locale);
    assert.ok(popupI18n.catalogs[locale].pasteTokenPlaceholder.length <= 16, `${locale} token placeholder should fit the compact input`);
    assert.deepEqual(
      Object.keys(popupI18n.catalogs[locale].languageNames).sort(),
      popupI18n.localeCodes.slice().sort(),
      `${locale} language names`
    );
    assert.deepEqual(
      Object.keys(popupI18n.catalogs[locale].themes).sort(),
      popupI18n.themes.slice().sort(),
      `${locale} theme names`
    );
    assert.deepEqual(
      Object.keys(popupI18n.catalogs[locale].contextMenu).sort(),
      ["downloadLink", "downloadSelectedLinks", "fetchMedia"],
      `${locale} context menu labels`
    );
    assert.deepEqual(
      Object.keys(popupI18n.catalogs[locale].notifications).sort(),
      Object.keys(popupI18n.catalogs.en.notifications).sort(),
      `${locale} notification labels`
    );
  }
});

test("keeps popup localization and disclosure wiring safe for packaging", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.html"), "utf8");
  const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "popup", "styles.css"), "utf8");

  assert.match(html, /locales\.js/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="pairing-content"/);
  assert.doesNotMatch(popupSource, /innerHTML/);
  assert.match(popupSource, /connectionRequestId/);
  assert.match(popupSource, /isCurrentRequest/);
  assert.match(popupSource, /storage\.onChanged\?\.addListener/);
  assert.match(popupSource, /storageChangedDuringLoad/);
  assert.match(popupSource, /addEventListener\('change', onSystemThemeChange\)/);
  assert.match(styles, /:root\[data-theme="light"\]/);
  assert.match(styles, /:root\[data-theme="dracula"\]/);
  assert.match(styles, /:root\[data-theme="nord"\]/);
  assert.match(styles, /\.pairing-header-copy\s*\{[\s\S]*flex: 1/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.match(styles, /overflow-y: auto/);
});
