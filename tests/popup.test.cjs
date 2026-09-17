const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupI18n = require("../popup/locales.js");
const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");

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
  assert.match(html, /id="media-status"[^>]*role="status"[^>]*aria-live="polite"/);
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

test("persists the first site exclusion when storage has no siteToggles key", async () => {
  const elements = new Map();
  const storageWrites = [];
  let domReady;
  const makeElement = () => ({
    addEventListener(type, listener) {
      this.listeners ||= {};
      this.listeners[type] = listener;
    },
    setAttribute() {},
    querySelector() { return makeElement(); },
    replaceChildren() {},
    classList: { add() {}, remove() {} },
    dataset: {},
    style: {},
    closest() { return null; },
    hidden: false,
    checked: false,
    disabled: false,
    value: "",
    textContent: ""
  });
  const ids = [
    "global-toggle", "site-toggle", "site-setting-row", "current-hostname",
    "settings-toggle", "settings-panel", "language-label", "theme-label",
    "language-select", "theme-select", "connection-status", "extension-token",
    "save-token-btn", "pairing-section", "pairing-content", "pairing-toggle-btn",
    "pairing-desc", "fetch-media-btn", "media-status", "fetch-media-label",
    "capture-downloads-label", "disable-on-site-label", "pairing-label"
  ];
  ids.forEach(id => elements.set(id, makeElement()));
  elements.get("connection-status").querySelector = () => makeElement();

  const context = vm.createContext({
    console,
    URL,
    navigator: { language: "en-US" },
    document: {
      activeElement: null,
      documentElement: { dataset: {}, style: {} },
      addEventListener(type, listener) {
        if (type === "DOMContentLoaded") domReady = listener;
      },
      getElementById(id) { return elements.get(id); },
      createElement() { return makeElement(); }
    },
    window: {
      matchMedia() {
        return { matches: false, addEventListener() {}, addListener() {} };
      }
    },
    FirelinkPopupI18n: popupI18n,
    FirelinkProtocol: { signedFetch: async () => ({ ok: true }) },
    chrome: {
      runtime: { lastError: null, sendMessage() {} },
      tabs: {
        query(_query, callback) {
          callback([{ url: "https://example.com/page" }]);
        }
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback({ globalCapture: true, extensionToken: "" });
          },
          set(value, callback) {
            storageWrites.push(value);
            callback?.();
          }
        },
        onChanged: { addListener() {} }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(popupSource, context);
  domReady();
  await new Promise(resolve => setImmediate(resolve));

  const siteToggle = elements.get("site-toggle");
  siteToggle.listeners.change({ target: { checked: true } });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(storageWrites.at(-1))), {
    siteToggles: { "example.com": true }
  });
});

test("serializes pairing-token saves so the latest value wins", async () => {
  const elements = new Map();
  const tokenSetCalls = [];
  const pendingTokenSets = [];
  let domReady;
  const makeElement = () => ({
    addEventListener(type, listener) {
      this.listeners ||= {};
      this.listeners[type] = listener;
    },
    setAttribute() {},
    querySelector() { return makeElement(); },
    replaceChildren() {},
    classList: { add() {}, remove() {} },
    dataset: {},
    style: {},
    closest() { return null; },
    hidden: false,
    checked: false,
    disabled: false,
    value: "",
    textContent: ""
  });
  const ids = [
    "global-toggle", "site-toggle", "site-setting-row", "current-hostname",
    "settings-toggle", "settings-panel", "language-label", "theme-label",
    "language-select", "theme-select", "connection-status", "extension-token",
    "save-token-btn", "pairing-section", "pairing-content", "pairing-toggle-btn",
    "pairing-desc", "fetch-media-btn", "media-status", "fetch-media-label",
    "capture-downloads-label", "disable-on-site-label", "pairing-label"
  ];
  ids.forEach(id => elements.set(id, makeElement()));
  elements.get("connection-status").querySelector = () => makeElement();

  const context = vm.createContext({
    console,
    URL,
    navigator: { language: "en-US" },
    document: {
      activeElement: null,
      documentElement: { dataset: {}, style: {} },
      addEventListener(type, listener) {
        if (type === "DOMContentLoaded") domReady = listener;
      },
      getElementById(id) { return elements.get(id); },
      createElement() { return makeElement(); }
    },
    window: {
      matchMedia() {
        return { matches: false, addEventListener() {}, addListener() {} };
      }
    },
    FirelinkPopupI18n: popupI18n,
    FirelinkProtocol: { signedFetch: async () => ({ ok: true }) },
    chrome: {
      runtime: { lastError: null, sendMessage() {} },
      tabs: {
        query(_query, callback) { callback([]); }
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback({ globalCapture: true, extensionToken: "" });
          },
          set(value) {
            if (Object.prototype.hasOwnProperty.call(value, "extensionToken")) {
              tokenSetCalls.push(value.extensionToken);
              return new Promise(resolve => pendingTokenSets.push(resolve));
            }
            return Promise.resolve();
          }
        },
        onChanged: { addListener() {} }
      }
    },
    setTimeout() { return 1; },
    clearTimeout() {}
  });

  vm.runInContext(popupSource, context);
  domReady();
  await new Promise(resolve => setImmediate(resolve));

  const tokenInput = elements.get("extension-token");
  const saveTokenButton = elements.get("save-token-btn");
  tokenInput.value = "old-token";
  tokenInput.listeners.input();
  saveTokenButton.listeners.click();
  tokenInput.value = "new-token";
  tokenInput.listeners.input();
  saveTokenButton.listeners.click();

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tokenSetCalls, ["old-token"]);
  pendingTokenSets.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tokenSetCalls, ["old-token", "new-token"]);
  pendingTokenSets.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokenSetCalls.at(-1), "new-token");
});

test("rolls back optimistic settings when browser storage rejects", async () => {
  const elements = new Map();
  let domReady;
  const makeElement = () => ({
    addEventListener(type, listener) {
      this.listeners ||= {};
      this.listeners[type] = listener;
    },
    setAttribute() {},
    querySelector() { return makeElement(); },
    replaceChildren() {},
    classList: { add() {}, remove() {} },
    dataset: {},
    style: {},
    closest() { return null; },
    hidden: false,
    checked: false,
    disabled: false,
    value: "",
    textContent: ""
  });
  const ids = [
    "global-toggle", "site-toggle", "site-setting-row", "current-hostname",
    "settings-toggle", "settings-panel", "language-label", "theme-label",
    "language-select", "theme-select", "connection-status", "extension-token",
    "save-token-btn", "pairing-section", "pairing-content", "pairing-toggle-btn",
    "pairing-desc", "fetch-media-btn", "media-status", "fetch-media-label",
    "capture-downloads-label", "disable-on-site-label", "pairing-label"
  ];
  ids.forEach(id => elements.set(id, makeElement()));
  elements.get("connection-status").querySelector = () => makeElement();

  const context = vm.createContext({
    console,
    URL,
    navigator: { language: "en-US" },
    document: {
      activeElement: null,
      documentElement: { dataset: {}, style: {} },
      addEventListener(type, listener) {
        if (type === "DOMContentLoaded") domReady = listener;
      },
      getElementById(id) { return elements.get(id); },
      createElement() { return makeElement(); }
    },
    window: {
      matchMedia() {
        return { matches: false, addEventListener() {}, addListener() {} };
      }
    },
    FirelinkPopupI18n: popupI18n,
    FirelinkProtocol: { signedFetch: async () => ({ ok: true }) },
    chrome: {
      runtime: { lastError: null, sendMessage() {} },
      tabs: {
        query(_query, callback) { callback([]); }
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback({ globalCapture: false, language: "system", theme: "system", extensionToken: "" });
          },
          set() {
            return Promise.reject(new Error("storage unavailable"));
          }
        },
        onChanged: { addListener() {} }
      }
    },
    setTimeout() { return 1; },
    clearTimeout() {}
  });

  vm.runInContext(popupSource, context);
  domReady();
  await new Promise(resolve => setImmediate(resolve));

  const globalToggle = elements.get("global-toggle");
  const languageSelect = elements.get("language-select");
  const themeSelect = elements.get("theme-select");
  globalToggle.checked = true;
  globalToggle.listeners.change({ target: globalToggle });
  languageSelect.value = "fa";
  languageSelect.listeners.change();
  themeSelect.value = "dark";
  themeSelect.listeners.change();

  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(globalToggle.checked, false);
  assert.equal(languageSelect.value, "system");
  assert.equal(themeSelect.value, "system");
});
