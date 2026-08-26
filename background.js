const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:", "magnet:"]);
const PAGE_MEDIA_SCHEMES = new Set(["http:", "https:"]);

const defaultSettings = {
  globalCapture: true,
  siteToggles: {},
  extensionToken: "",
  language: "system",
  launchTimeoutCount: 0,
  launchCooldownUntil: 0
};

let cachedSettings = { ...defaultSettings };
const LAUNCH_URL = "firelink://launch";
const MEDIA_FETCH_PROTOCOL_VERSION = 4;
const LAUNCH_TIMEOUT_MS = 15000;
const LAUNCH_RETRY_MS = 500;
const LAUNCH_TIMEOUTS_BEFORE_COOLDOWN = 2;
const LAUNCH_COOLDOWN_MS = 60000;
const CAPTURE_FILENAME_SETTLE_TIMEOUT_MS = 2500;
const TORRENT_CAPTURE_PROTOCOL_VERSION = 5;
const WEAK_CAPTURE_FILENAMES = new Set(["identifier", "download", "view", "uc"]);
const TORRENT_MIME_TYPES = new Set([
  "application/bittorrent",
  "application/x-bittorrent",
  "application/x-torrent"
]);
const MAX_HANDOFF_URLS = 200;
const PENDING_CAPTURE_STORAGE_KEY = "pendingAutomaticCaptures";
const PENDING_CAPTURE_RECOVERY_ALARM = "firelink-pending-capture-recovery";
const PENDING_CAPTURE_RECOVERY_DELAY_MS = 30_000;
let launchSession = null;
let launchCleanup = Promise.resolve();
const pendingDownloadFilenameWaits = new Map();
let pendingCaptureMutation = Promise.resolve();
let pendingCaptureRecovery = null;
const activeAutomaticCaptures = new Map();
const SETTINGS_KEYS = [
  "globalCapture",
  "siteToggles",
  "extensionToken",
  "language",
  "launchTimeoutCount",
  "launchCooldownUntil"
];
const CAPTURE_POLICY_KEYS = new Set(["globalCapture", "siteToggles", "extensionToken"]);
let settingsLoadInProgress = true;
const settingsChangedDuringLoad = new Set();
let capturePolicyRevision = 0;

function normalizeExtensionToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSiteToggles(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

const truncateByCodePoints = (value, maxCodePoints) =>
  Array.from(value).slice(0, maxCodePoints).join("");

const reportContextMenuHandoffFailure = (action, error) => {
  console.error(`Firelink ${action} handoff failed:`, error);
};

function callExtensionApi(target, methodName, args = []) {
  const method = target?.[methodName];
  if (typeof method !== "function") {
    return Promise.resolve({ ok: false, value: undefined });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok, value });
    };
    const callback = (...values) => {
      if (chrome.runtime?.lastError) {
        finish(false, undefined);
        return;
      }
      finish(true, values.length <= 1 ? values[0] : values);
    };

    try {
      const result = method.call(target, ...args, callback);
      if (result && typeof result.then === "function") {
        result.then(value => finish(true, value), () => finish(false, undefined));
      }
    } catch (error) {
      finish(false, undefined);
    }
  });
}

const sendContextMenuHandoff = (urls, referer, options) => {
  void sendToFirelink(urls, referer, options)
    .catch(error => reportContextMenuHandoffFailure("context-menu", error));
};

const settingsLoaded = new Promise(resolve => {
  const finish = result => {
    result = result && typeof result === "object" ? result : {};
    if (result.globalCapture !== undefined && !settingsChangedDuringLoad.has("globalCapture")) {
      cachedSettings.globalCapture = result.globalCapture;
    }
    if (result.siteToggles !== undefined && !settingsChangedDuringLoad.has("siteToggles")) {
      cachedSettings.siteToggles = normalizeSiteToggles(result.siteToggles);
    }
    if (result.extensionToken !== undefined && !settingsChangedDuringLoad.has("extensionToken")) {
      cachedSettings.extensionToken = normalizeExtensionToken(result.extensionToken);
    }
    if (result.language !== undefined && !settingsChangedDuringLoad.has("language")) {
      cachedSettings.language = result.language;
    }
    if (result.launchTimeoutCount !== undefined && !settingsChangedDuringLoad.has("launchTimeoutCount")) {
      cachedSettings.launchTimeoutCount = normalizeNonNegativeInteger(result.launchTimeoutCount);
    }
    if (result.launchCooldownUntil !== undefined && !settingsChangedDuringLoad.has("launchCooldownUntil")) {
      cachedSettings.launchCooldownUntil = normalizeNonNegativeInteger(result.launchCooldownUntil);
    }
    settingsLoadInProgress = false;
    resolve();
  };

  void callExtensionApi(chrome.storage?.local, "get", [SETTINGS_KEYS])
    .then(result => finish(result.ok ? result.value : {}));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes || typeof changes !== "object") {
    return;
  }
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) {
      continue;
    }
    const change = changes[key];
    if (!change || typeof change !== "object") {
      continue;
    }
    if (settingsLoadInProgress) {
      settingsChangedDuringLoad.add(key);
    }
    cachedSettings[key] = key === "extensionToken"
      ? normalizeExtensionToken(change.newValue)
      : key === "siteToggles"
      ? normalizeSiteToggles(change.newValue)
      : key === "launchTimeoutCount"
      ? normalizeNonNegativeInteger(change.newValue)
      : key === "launchCooldownUntil"
      ? normalizeNonNegativeInteger(change.newValue)
      : change.newValue;
    if (CAPTURE_POLICY_KEYS.has(key)) {
      capturePolicyRevision += 1;
    }
    if (key === "language") {
      void registerContextMenus();
    }
  }
});

function currentBackgroundCatalog() {
  const i18n = globalThis.FirelinkPopupI18n;
  if (!i18n?.catalogs) {
    return {};
  }

  const preference = i18n.normalizeLanguagePreference(cachedSettings.language);
  const locale = preference === "system"
    ? i18n.resolveLocale(navigator.language)
    : preference;
  return i18n.catalogs[locale] || i18n.catalogs.en || {};
}

function backgroundText(section, key, fallback) {
  return currentBackgroundCatalog()[section]?.[key] || fallback;
}

let contextMenuRegistration = Promise.resolve();

function registerContextMenus() {
  contextMenuRegistration = contextMenuRegistration
    .catch(() => {})
    .then(async () => {
      if (!chrome.contextMenus?.removeAll || !chrome.contextMenus?.create) {
        return;
      }

      const removed = await callExtensionApi(chrome.contextMenus, "removeAll");
      if (!removed.ok) {
        return;
      }

      const contextMenu = currentBackgroundCatalog().contextMenu || {};
      const items = [
        {
          id: "download-with-firelink",
          title: contextMenu.downloadLink || "Download with Firelink",
          contexts: ["link"]
        },
        {
          id: "download-selected-with-firelink",
          title: contextMenu.downloadSelectedLinks || "Download selected links with Firelink",
          contexts: ["selection"]
        },
        {
          id: "fetch-media-with-firelink",
          title: contextMenu.fetchMedia || "Fetch media with Firelink",
          contexts: ["page", "link", "video", "audio"]
        }
      ];
      const pendingCreates = [];
      for (const item of items) {
        try {
          const result = chrome.contextMenus.create(item);
          if (result && typeof result.catch === "function") {
            pendingCreates.push(result.catch(error => {
              console.error("Firelink context menu registration failed:", error);
            }));
          }
        } catch (error) {
          console.error("Firelink context menu registration failed:", error);
        }
      }
      await Promise.all(pendingCreates);
    });
  return contextMenuRegistration;
}

void settingsLoaded.then(registerContextMenus);

chrome.runtime.onInstalled.addListener(() => {
  void callExtensionApi(chrome.storage?.local, "get", [SETTINGS_KEYS]).then(({ ok, value }) => {
    if (!ok) {
      return;
    }
    const result = value && typeof value === "object" ? value : {};
    const missingSettings = {};
    for (const [key, defaultValue] of Object.entries(defaultSettings)) {
      if (result[key] === undefined) {
        missingSettings[key] = defaultValue;
      }
    }
    if (Object.keys(missingSettings).length > 0) {
      void callExtensionApi(chrome.storage?.local, "set", [missingSettings]);
    }
  });
  void settingsLoaded.then(registerContextMenus);
});

function normalizeURL(rawURL, { trimTextDecorations = false } = {}) {
  if (typeof rawURL !== "string") {
    return null;
  }

  let trimmed = rawURL.trim();
  if (trimTextDecorations) {
    const leadingWrappers = new Set(["<", "(", "\"", "'", "["]);
    const trailingPunctuation = new Set([
      ">", ")", "\"", "'", "]", ".", ",", ";", ":", "!", "?"
    ]);

    while (trimmed && leadingWrappers.has(trimmed[0])) {
      trimmed = trimmed.slice(1);
    }
    while (trimmed && trailingPunctuation.has(trimmed[trimmed.length - 1])) {
      trimmed = trimmed.slice(0, -1);
    }
  }

  try {
    const url = new URL(trimmed);
    return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
  } catch (error) {
    return null;
  }
}

function extractURLsFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  const urls = [];
  const seen = new Set();
  const pattern = /(?:\b(?:https?|ftp|sftp):\/\/[^\s<>"']+|\bmagnet:\?[^\s<>"']+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const url = normalizeURL(match[0], { trimTextDecorations: true });
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
    if (urls.length >= MAX_HANDOFF_URLS) {
      break;
    }
  }
  return urls;
}

function normalizeURLList(urls) {
  const rawURLs = Array.isArray(urls) ? urls : [urls];
  const normalized = [];
  const seen = new Set();
  for (const rawURL of rawURLs) {
    const url = normalizeURL(rawURL);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    normalized.push(url);
    if (normalized.length >= MAX_HANDOFF_URLS) {
      break;
    }
  }
  return normalized;
}

function normalizePageMediaURL(rawURL) {
  if (typeof rawURL !== "string") {
    return null;
  }

  try {
    const url = new URL(rawURL.trim());
    return PAGE_MEDIA_SCHEMES.has(url.protocol) ? url.href : null;
  } catch (error) {
    return null;
  }
}

function captureEnabledForURL(rawURL) {
  const globalCapture = cachedSettings.globalCapture === true;
  if (!globalCapture) {
    return false;
  }

  try {
    const hostname = new URL(rawURL).hostname;
    return cachedSettings.siteToggles?.[hostname] !== true;
  } catch (error) {
    return false;
  }
}

function automaticCaptureAllowedForDownload(rawURL, referrer = "") {
  if (!normalizeURL(rawURL)) {
    return false;
  }

  let settingsURL = rawURL;
  if (typeof referrer === "string" && referrer.trim()) {
    try {
      new URL(referrer);
      settingsURL = referrer;
    } catch (error) {
      // A malformed referrer must not hide an otherwise valid download URL.
    }
  }

  return Boolean(cachedSettings.extensionToken)
    && captureEnabledForURL(settingsURL);
}

function notify(title, message) {
  if (!chrome.notifications?.create) {
    return false;
  }
  try {
    const result = chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
    return true;
  } catch (error) {
    return false;
  }
}

function createLaunchTab() {
  return callExtensionApi(chrome.tabs, "create", [{ url: LAUNCH_URL, active: true }])
    .then(result => result.ok ? result.value?.id ?? null : null);
}

function closeLaunchTab(tabId) {
  if (tabId === null || tabId === undefined || !chrome.tabs?.remove) {
    return Promise.resolve();
  }
  return callExtensionApi(chrome.tabs, "remove", [tabId]).then(() => {});
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePendingCaptureMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [id, record] of Object.entries(value)) {
    const numericId = Number(id);
    if (!/^\d+$/.test(id)
      || !record
      || typeof record !== "object"
      || !Number.isSafeInteger(numericId)
      || numericId < 0
      || (record.id !== undefined && Number(record.id) !== numericId)
      || typeof record.url !== "string"
      || !normalizeURL(record.url)
      || (record.startTime !== undefined
        && typeof record.startTime !== "string"
        && !(typeof record.startTime === "number" && Number.isFinite(record.startTime)))
      || !["paused", "ready", "sending", "accepted", "uncertain"].includes(record.phase)) {
      continue;
    }

    normalized[String(numericId)] = {
      ...record,
      id: numericId,
      ...(record.startTime !== undefined
        ? { startTime: String(record.startTime) }
        : {}),
      ...(typeof record.mime === "string" ? { mime: record.mime } : {})
    };
  }
  return normalized;
}

function readPendingCaptureMap() {
  if (!chrome.storage?.local?.get) {
    return Promise.reject(new Error("Browser storage is unavailable"));
  }

  return callExtensionApi(
    chrome.storage.local,
    "get",
    [[PENDING_CAPTURE_STORAGE_KEY]]
  ).then(result => {
    if (!result.ok) {
      throw new Error("Could not read automatic capture state");
    }
    return normalizePendingCaptureMap(result.value?.[PENDING_CAPTURE_STORAGE_KEY]);
  });
}

function writePendingCaptureMap(value) {
  if (!chrome.storage?.local?.set) {
    return Promise.resolve(false);
  }

  return callExtensionApi(chrome.storage.local, "set", [{
    [PENDING_CAPTURE_STORAGE_KEY]: normalizePendingCaptureMap(value)
  }]).then(result => result.ok);
}

function schedulePendingCaptureRecovery() {
  if (!chrome.alarms?.create) {
    return;
  }
  try {
    const result = chrome.alarms.create(PENDING_CAPTURE_RECOVERY_ALARM, {
      when: Date.now() + PENDING_CAPTURE_RECOVERY_DELAY_MS
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (error) {
    // The storage record remains the source of truth if alarms are unavailable.
  }
}

function clearPendingCaptureRecovery() {
  if (!chrome.alarms?.clear) {
    return;
  }
  try {
    const result = chrome.alarms.clear(PENDING_CAPTURE_RECOVERY_ALARM);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (error) {
    // A stale one-shot alarm is harmless; the next worker wake will reconcile it.
  }
}

function mutatePendingCaptureMap(mutator) {
  const operation = pendingCaptureMutation.then(async () => {
    const current = await readPendingCaptureMap();
    const next = normalizePendingCaptureMap(mutator(current));
    if (!await writePendingCaptureMap(next)) {
      throw new Error("Could not persist automatic capture state");
    }
    if (Object.keys(next).length > 0) {
      schedulePendingCaptureRecovery();
    } else {
      clearPendingCaptureRecovery();
    }
    return next;
  });
  pendingCaptureMutation = operation.catch(() => {});
  return operation;
}

function createPendingCaptureRecord(downloadItem, phase = "paused", filename) {
  return {
    id: downloadItem.id,
    url: downloadItem.url,
    finalUrl: typeof downloadItem.finalUrl === "string" ? downloadItem.finalUrl : undefined,
    referrer: typeof downloadItem.referrer === "string" ? downloadItem.referrer : "",
    filename: normalizeCaptureFilename(filename ?? downloadItem.filename),
    cookieStoreId: typeof downloadItem.cookieStoreId === "string"
      ? downloadItem.cookieStoreId
      : undefined,
    incognito: downloadItem.incognito === true,
    ...(downloadItem.startTime !== undefined
      && downloadItem.startTime !== null
      ? { startTime: String(downloadItem.startTime) }
      : {}),
    mime: typeof downloadItem.mime === "string" ? downloadItem.mime : undefined,
    phase,
    updatedAt: Date.now()
  };
}

function savePendingCapture(record) {
  return mutatePendingCaptureMap(current => ({
    ...current,
    [String(record.id)]: { ...record, updatedAt: Date.now() }
  })).then(() => true, () => false);
}

function updatePendingCapture(recordId, changes) {
  let updated = false;
  return mutatePendingCaptureMap(current => {
    const existing = current[String(recordId)];
    if (!existing) {
      return current;
    }
    updated = true;
    return {
      ...current,
      [String(recordId)]: { ...existing, ...changes, updatedAt: Date.now() }
    };
  }).then(() => updated, () => false);
}

function removePendingCapture(recordId) {
  return mutatePendingCaptureMap(current => {
    const next = { ...current };
    delete next[String(recordId)];
    return next;
  }).then(() => true, () => false);
}

async function markAmbiguousCapture(recordId) {
  if (!await updatePendingCapture(recordId, { phase: "uncertain" })) {
    schedulePendingCaptureRecovery();
  }
  notifyAmbiguousAutomaticCapture();
}

function beginAutomaticCapture(downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 0
    || activeAutomaticCaptures.has(downloadId)) {
    return null;
  }
  const session = {
    downloadId,
    userResumed: false,
    terminal: false,
    downloadMissing: false,
    downloadLookupFailed: false,
    handoffStarted: false,
    handoffMayHaveBeenSent: false,
    cleanupStarted: false,
    cleanupTerminalExpected: false
  };
  activeAutomaticCaptures.set(downloadId, session);
  return session;
}

function noteAutomaticCaptureChange(
  downloadId,
  { resumed = false, terminal = false, terminalState = undefined } = {}
) {
  const session = activeAutomaticCaptures.get(downloadId);
  if (!session) {
    return false;
  }
  if (resumed) {
    session.userResumed = true;
  }
  // A terminal event caused by our own cancel/erase is expected during the
  // cleanup window. A resume is always user intent and must be observed even
  // while cleanup is in flight.
  const expectedCancellation = session.cleanupTerminalExpected
    && terminalState === "interrupted";
  if (terminal && !expectedCancellation) {
    session.terminal = true;
  }
  return true;
}

function automaticCaptureInvalidated(session) {
  return session.userResumed || session.terminal || session.downloadMissing;
}

function downloadStartTime(downloadItem) {
  if (downloadItem?.startTime === undefined || downloadItem?.startTime === null) {
    return undefined;
  }
  return String(downloadItem.startTime);
}

function pendingCaptureMatchesDownload(record, downloadItem) {
  if (!downloadItem || downloadItem.id !== record.id) {
    return false;
  }

  const expectedURLs = [record.url, record.finalUrl]
    .map(normalizeURL)
    .filter(Boolean);
  const actualURLs = [downloadItem.url, downloadItem.finalUrl]
    .map(normalizeURL)
    .filter(Boolean);
  if (expectedURLs.length === 0 || !actualURLs.some(url => expectedURLs.includes(url))) {
    return false;
  }

  if (record.incognito === true && downloadItem.incognito !== true) {
    return false;
  }
  if (typeof downloadItem.incognito === "boolean"
    && downloadItem.incognito !== (record.incognito === true)) {
    return false;
  }
  if (typeof record.cookieStoreId === "string"
    && record.cookieStoreId !== downloadItem.cookieStoreId) {
    return false;
  }
  if (record.startTime !== undefined
    && record.startTime !== downloadStartTime(downloadItem)) {
    return false;
  }
  return true;
}

function isTerminalDownload(downloadItem) {
  return downloadItem?.state === "complete" || downloadItem?.state === "interrupted";
}

async function findOwnedAutomaticDownload(record, session) {
  if (automaticCaptureInvalidated(session)) {
    return null;
  }

  let downloadItem;
  try {
    downloadItem = await findDownload(record.id);
  } catch (error) {
    session.downloadLookupFailed = true;
    return null;
  }
  if (!downloadItem) {
    session.downloadMissing = true;
    return null;
  }
  if (!pendingCaptureMatchesDownload(record, downloadItem)) {
    session.downloadMissing = true;
    return null;
  }
  if (isTerminalDownload(downloadItem)) {
    session.terminal = true;
    return null;
  }
  if (downloadItem.paused !== true) {
    session.userResumed = true;
    return null;
  }
  return downloadItem;
}

async function removePendingCaptureAndResume(recordId, session) {
  let pending;
  try {
    pending = await readPendingCaptureMap();
  } catch (error) {
    schedulePendingCaptureRecovery();
    return false;
  }
  const record = pending[String(recordId)];
  let downloadItem = null;
  if (record) {
    try {
      downloadItem = await findDownload(recordId);
    } catch (error) {
      schedulePendingCaptureRecovery();
      return false;
    }
  }
  if (!record || !downloadItem || !pendingCaptureMatchesDownload(record, downloadItem)) {
    const removed = await removePendingCapture(recordId);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    return false;
  }
  if (isTerminalDownload(downloadItem) || downloadItem.paused !== true) {
    const removed = await removePendingCapture(recordId);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    return false;
  }

  if (session) {
    session.cleanupStarted = true;
  }
  let resumed = false;
  try {
    resumed = await runDownloadAction("resume", recordId);
  } finally {
    if (session) {
      session.cleanupStarted = false;
    }
  }
  if (!resumed) {
    if (!await updatePendingCapture(recordId, { phase: "ready" })) {
      schedulePendingCaptureRecovery();
    }
    return false;
  }

  // Remove the ownership record only after the browser accepted the resume.
  // If storage removal fails, recovery can observe the resumed item and clear
  // the stale ready record without pausing or recapturing it.
  const removed = await removePendingCapture(recordId);
  if (!removed) {
    schedulePendingCaptureRecovery();
  }
  return removed;
}

async function resumeAndForgetAutomaticCapture(recordId, session) {
  if (session) {
    session.cleanupStarted = true;
  }
  let resumed = false;
  try {
    resumed = await runDownloadAction("resume", recordId);
  } finally {
    if (session) {
      session.cleanupStarted = false;
    }
  }
  if (resumed) {
    const removed = await removePendingCapture(recordId);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
  } else {
    await updatePendingCapture(recordId, { phase: "ready" });
    schedulePendingCaptureRecovery();
  }
  return resumed;
}

function findDownload(downloadId) {
  if (!chrome.downloads?.search) {
    return Promise.reject(new Error("Browser downloads API is unavailable"));
  }

  return callExtensionApi(chrome.downloads, "search", [{ id: downloadId }]).then(result => {
    if (!result.ok) {
      throw new Error("Could not inspect browser download");
    }
    return Array.isArray(result.value) ? result.value[0] || null : null;
  });
}

function storeLaunchState(timeoutCount, cooldownUntil) {
  cachedSettings.launchTimeoutCount = timeoutCount;
  cachedSettings.launchCooldownUntil = cooldownUntil;
  void callExtensionApi(chrome.storage?.local, "set", [{
    launchTimeoutCount: timeoutCount,
    launchCooldownUntil: cooldownUntil
  }]);
}

async function waitForFirelink(token, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await FirelinkProtocol.signedFetch("/ping", token);
      return true;
    } catch (error) {
      lastError = error;
      if (error?.serverReached && [403, 426].includes(error.status)) {
        throw error;
      }
      await delay(LAUNCH_RETRY_MS);
    }
  }
  throw lastError || new Error("Firelink launch timed out");
}

async function deliverAfterStartup(entry, deadline) {
  while (Date.now() < deadline) {
    try {
      await FirelinkProtocol.signedFetch("/download", entry.token, {
        method: "POST",
        payload: entry.payload,
        requiredProtocolVersion: entry.requiredProtocolVersion
      });
      return true;
    } catch (error) {
      if (error?.status === 503 && error?.serverReached) {
        await delay(LAUNCH_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Firelink launch timed out");
}

function enqueueLaunchDelivery(token, payload, requiredProtocolVersion, options = {}) {
  return new Promise(resolve => {
    const entry = {
      token,
      payload: Object.freeze({ ...payload, urls: Object.freeze([...payload.urls]) }),
      requiredProtocolVersion,
      deadline: Date.now() + LAUNCH_TIMEOUT_MS,
      onRequestMayHaveBeenSent: options.onRequestMayHaveBeenSent,
      resolve
    };

    const appendToSession = session => {
      session.entries.push(entry);
      if (!session.running) {
        session.running = true;
        void runLaunchSession(session);
      }
    };

    const queueEntry = async () => {
      if (launchSession && !launchSession.closing) {
        appendToSession(launchSession);
        return;
      }

      await launchCleanup;
      if (launchSession && !launchSession.closing) {
        appendToSession(launchSession);
        return;
      }

      launchSession = {
        entries: [],
        running: false,
        closing: false
      };
      appendToSession(launchSession);
    };

    void queueEntry();
  });
}

async function runLaunchSession(session) {
  let tabId = null;
  let launchFailed = false;
  let deliveryFailed = false;
  let launchError = null;

  try {
    tabId = await createLaunchTab();
    if (tabId === null) {
      throw new Error("Firelink protocol is not registered");
    }
    await waitForFirelink(session.entries[0].token, session.entries[0].deadline);

    let index = 0;
    while (index < session.entries.length) {
      const entry = session.entries[index];
      try {
        entry.result = await deliverAfterStartup(entry, entry.deadline);
      } catch (error) {
        reportAmbiguousHandoff(entry, error);
        entry.result = false;
        deliveryFailed = true;
      }
      index += 1;
      if (index === session.entries.length) {
        await delay(0);
      }
    }
  } catch (error) {
    launchFailed = true;
    launchError = error;
    session.entries.forEach(entry => {
      entry.result = false;
    });
  } finally {
    session.closing = true;
    launchCleanup = Promise.resolve(closeLaunchTab(tabId)).catch(() => {});
    await launchCleanup;
    if (launchSession === session) {
      launchSession = null;
    }
    if (launchFailed && launchError?.serverReached && launchError?.status === 403) {
      storeLaunchState(0, 0);
      notify(
        backgroundText("notifications", "connectionRejectedTitle", "Firelink Connection Rejected"),
        backgroundText(
          "notifications",
          "connectionRejectedMessage",
          "Your pairing token is invalid. Update it in the Firelink extension popup."
        )
      );
    } else if (launchFailed && launchError?.serverReached && launchError?.status === 426) {
      storeLaunchState(0, 0);
      notify(
        backgroundText("notifications", "updateTitle", "Firelink Update Required"),
        backgroundText(
          "notifications",
          "updateMessage",
          "Update the Firelink desktop app to use browser integration."
        )
      );
    } else if (launchFailed) {
      const timeoutCount = (cachedSettings.launchTimeoutCount || 0) + 1;
      const cooldownUntil = timeoutCount >= LAUNCH_TIMEOUTS_BEFORE_COOLDOWN
        ? Date.now() + LAUNCH_COOLDOWN_MS
        : 0;
      storeLaunchState(timeoutCount, cooldownUntil);
      notify(
        backgroundText("notifications", "notOpenedTitle", "Firelink Was Not Opened"),
        cooldownUntil
          ? backgroundText(
            "notifications",
            "notOpenedCooldown",
            "Your browser could not open Firelink. Check protocol permission, open Firelink once, then retry."
          )
          : backgroundText(
            "notifications",
            "notOpenedPrompt",
            "Approve your browser's prompt to open Firelink. No download was added."
          )
      );
    } else {
      storeLaunchState(0, 0);
      if (deliveryFailed) {
        notify(
          backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
          backgroundText(
            "notifications",
            "handoffRejected",
            "Firelink opened but rejected a download request. No duplicate request was sent."
          )
        );
      }
    }
    session.entries.forEach(entry => entry.resolve(entry.result === true));
  }
}

async function collectCookieHeader(url, cookieStoreId) {
  if (!chrome.cookies) {
    return "";
  }

  try {
    const details = cookieStoreId ? { url, storeId: cookieStoreId } : { url };
    const result = await callExtensionApi(chrome.cookies, "getAll", [details]);
    if (!result.ok || !Array.isArray(result.value)) {
      return "";
    }
    return result.value
      .filter(cookie => cookie && typeof cookie.name === "string" && typeof cookie.value === "string")
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join("; ");
  } catch (error) {
    return "";
  }
}

function captureCookieScopeUrls(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    return [];
  }

  const urls = [parsed.toString()];
  const hostname = parsed.hostname.toLowerCase();
  const isGoogleCapture = hostname === "mail.google.com"
    || hostname === "accounts.google.com"
    || hostname === "googleusercontent.com"
    || hostname.endsWith(".googleusercontent.com");
  if (!isGoogleCapture) {
    return urls;
  }

  const origins = [
    `https://${hostname}/`,
    "https://mail.google.com/",
    "https://accounts.google.com/",
    "https://googleusercontent.com/"
  ];

  return [...new Set([...urls, ...origins])];
}

async function collectCookieScopes(url, cookieStoreId) {
  const scopeUrls = captureCookieScopeUrls(url);
  const scopes = await Promise.all(scopeUrls.map(async scopeUrl => ({
    url: scopeUrl,
    cookies: await collectCookieHeader(scopeUrl, cookieStoreId)
  })));
  return scopes.filter(scope => scope.cookies);
}

function handoffMayHaveBeenSent(error) {
  return error?.requestMayHaveBeenSent === true
    || (error?.serverReached === true && error?.status === 504);
}

function reportAmbiguousHandoff(options, error) {
  const requestMayHaveBeenSent = handoffMayHaveBeenSent(error);
  if (requestMayHaveBeenSent && typeof options.onRequestMayHaveBeenSent === "function") {
    options.onRequestMayHaveBeenSent();
  }
}

async function resolveCookieStoreId(options = {}) {
  if (typeof options.cookieStoreId === "string" && options.cookieStoreId) {
    return options.cookieStoreId;
  }
  if (!chrome.cookies) {
    return options.incognito === true ? null : undefined;
  }
  if (options.incognito !== true) {
    return undefined;
  }
  if (typeof chrome.cookies.getAllCookieStores !== "function") {
    return null;
  }

  try {
    const result = await callExtensionApi(chrome.cookies, "getAllCookieStores");
    if (!result.ok || !Array.isArray(result.value)) {
      return null;
    }
    const incognitoStores = result.value.filter(store =>
      store?.incognito && typeof store.id === "string" && store.id
    );
    return incognitoStores.length === 1 ? incognitoStores[0].id : null;
  } catch (error) {
    return null;
  }
}

function normalizeCaptureFilename(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/^.*[\\/]/, "").trim();
}

function isUsableCaptureFilename(value) {
  const filename = normalizeCaptureFilename(value);
  return Boolean(filename) && !WEAK_CAPTURE_FILENAMES.has(filename.toLowerCase());
}

function isTorrentFilename(value) {
  return normalizeCaptureFilename(value).toLowerCase().endsWith(".torrent");
}

function isTorrentURL(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.pathname.toLowerCase().endsWith(".torrent");
  } catch (error) {
    return false;
  }
}

function isMagnetURL(value) {
  try {
    return new URL(value).protocol === "magnet:";
  } catch (error) {
    return false;
  }
}

function isTorrentMime(value) {
  if (typeof value !== "string") {
    return false;
  }
  return TORRENT_MIME_TYPES.has(value.split(";", 1)[0].trim().toLowerCase());
}

function isTorrentDownload(downloadItem, filename) {
  return isTorrentFilename(filename)
    || isTorrentMime(downloadItem?.mime)
    || [downloadItem?.url, downloadItem?.finalUrl].some(value =>
      isTorrentURL(value) || isMagnetURL(value)
    );
}

function settleDownloadFilenameWait(downloadId, filename) {
  const pending = pendingDownloadFilenameWaits.get(downloadId);
  if (!pending) {
    return;
  }
  pendingDownloadFilenameWaits.delete(downloadId);
  clearTimeout(pending.timeout);
  pending.resolve(isUsableCaptureFilename(filename) ? normalizeCaptureFilename(filename) : undefined);
}

function waitForDownloadFilename(downloadItem) {
  const initialFilename = normalizeCaptureFilename(downloadItem.filename);
  if (isUsableCaptureFilename(initialFilename)) {
    return {
      promise: Promise.resolve(initialFilename),
      cancel: () => {}
    };
  }

  let resolveWait;
  const promise = new Promise(resolve => {
    resolveWait = resolve;
  });
  const timeout = setTimeout(() => settleDownloadFilenameWait(downloadItem.id), CAPTURE_FILENAME_SETTLE_TIMEOUT_MS);
  pendingDownloadFilenameWaits.set(downloadItem.id, { resolve: resolveWait, timeout });
  return {
    promise,
    cancel: () => settleDownloadFilenameWait(downloadItem.id)
  };
}

async function sendToFirelink(urls, referer = "", options = {}) {
  await settingsLoaded;

  const captureMode = options.captureMode === "automatic" ? "automatic" : "manual";
  const notifyOnFailure = options.notifyOnFailure !== false;
  const allowProtocolFallback = options.allowProtocolFallback !== false;
  const normalizedURLs = normalizeURLList(urls);
  if (normalizedURLs.length === 0) {
    return false;
  }

  if (!cachedSettings.extensionToken) {
    if (notifyOnFailure) {
      notify(
        backgroundText("notifications", "setupTitle", "Firelink Setup Required"),
        backgroundText(
          "notifications",
          "setupMessage",
          "Please click the Firelink extension icon and paste the pairing token."
        )
      );
    }
    return false;
  }

  const shouldForwardCookies = normalizedURLs.length === 1
    && !isMagnetURL(normalizedURLs[0])
    && (captureMode === "automatic" || options.forwardCookies === true);
  const cookieStoreId = shouldForwardCookies
    ? await resolveCookieStoreId(options)
    : undefined;
  const cookieScopes = shouldForwardCookies
    && cookieStoreId !== null
    ? await collectCookieScopes(normalizedURLs[0], cookieStoreId)
    : [];
  const cookieString = cookieScopes.find(scope => scope.url === normalizedURLs[0])?.cookies || "";

  const containsTorrentURL = normalizedURLs.some(url => isTorrentURL(url) || isMagnetURL(url));
  // The desktop torrent contract is intentionally single-source. A mixed
  // selection can still include a magnet as an ordinary Add-modal row, but it
  // must not be mislabeled as one torrent request and rejected as a batch.
  const isTorrent = options.media !== true
    && normalizedURLs.length === 1
    && (options.torrent === true || containsTorrentURL);
  const payload = {
    urls: normalizedURLs,
    referer,
    silent: captureMode === "automatic",
    filename: options.filename,
    headers: options.includeUserAgent === false
      || typeof navigator === "undefined"
      || typeof navigator.userAgent !== "string"
      ? undefined
      : `User-Agent: ${navigator.userAgent}`,
    cookies: cookieString || undefined,
    cookie_scopes: cookieScopes.length > 0 ? cookieScopes : undefined,
    media: options.media === true
  };
  if (isTorrent) {
    payload.torrent = true;
  }
  if (options.batch === true && normalizedURLs.length >= 2) {
    payload.batch = true;
    if (typeof options.batchName === "string" && options.batchName.trim()) {
      payload.batch_name = truncateByCodePoints(options.batchName.trim(), 512);
    }
  }

  const requiredProtocolVersion = options.media === true
    ? MEDIA_FETCH_PROTOCOL_VERSION
    : (isTorrent || containsTorrentURL || options.torrent === true)
    ? TORRENT_CAPTURE_PROTOCOL_VERSION
    : captureMode === "automatic" ? 3 : undefined;

  try {
    await FirelinkProtocol.signedFetch("/download", cachedSettings.extensionToken, {
      method: "POST",
      payload,
      requiredProtocolVersion
    });
    return true;
  } catch (error) {
    if (error?.serverReached && error?.status === 426) {
      const requestMayHaveBeenSent = handoffMayHaveBeenSent(error);
      reportAmbiguousHandoff(options, error);
      if (notifyOnFailure) {
        notify(
          backgroundText(
            "notifications",
            requestMayHaveBeenSent ? "handoffFailedTitle" : "updateTitle",
            requestMayHaveBeenSent ? "Firelink Handoff Failed" : "Firelink Update Required"
          ),
          requestMayHaveBeenSent
            ? backgroundText(
              "notifications",
              "ambiguousManual",
              "Firelink may have received the request. Check Firelink before trying again."
            )
            : backgroundText(
              "notifications",
              "updateMessage",
              "Update the Firelink desktop app to use browser integration."
            )
        );
      }
      return false;
    }

    if (error?.serverReached && error?.status === 403) {
      if (notifyOnFailure) {
        notify(
          backgroundText("notifications", "connectionRejectedTitle", "Firelink Connection Rejected"),
          backgroundText(
            "notifications",
            "connectionRejectedMessage",
            "Your pairing token is invalid. Update it in the Firelink extension popup."
          )
        );
      }
      return false;
    }

    if (error?.serverReached && error?.status === 503) {
      try {
        return await deliverAfterStartup(
          { token: cachedSettings.extensionToken, payload, requiredProtocolVersion },
          Date.now() + LAUNCH_TIMEOUT_MS
        );
      } catch (retryError) {
        reportAmbiguousHandoff(options, retryError);
        if (notifyOnFailure) {
          notify(
            backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
            handoffMayHaveBeenSent(retryError)
              ? backgroundText(
                "notifications",
                "ambiguousManual",
                "Firelink may have received the request. Check Firelink before trying again."
              )
              : backgroundText(
                "notifications",
                "notReady",
                "Firelink started but was not ready to accept the download."
              )
          );
        }
        return false;
      }
    }

    const canUseProtocol = allowProtocolFallback
      && !error?.serverReached
      && !error?.requestMayHaveBeenSent;
    if (canUseProtocol) {
      if ((cachedSettings.launchCooldownUntil || 0) > Date.now()) {
        if (notifyOnFailure) {
          notify(
            backgroundText("notifications", "launchAttentionTitle", "Firelink Launch Needs Attention"),
            backgroundText(
              "notifications",
              "launchAttentionMessage",
              "Open Firelink manually and confirm your browser is allowed to open firelink links, then retry."
            )
          );
        }
        return false;
      }
      return enqueueLaunchDelivery(
        cachedSettings.extensionToken,
        payload,
        requiredProtocolVersion,
        options
      );
    }

    reportAmbiguousHandoff(options, error);

    if (notifyOnFailure) {
      notify(
        backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
        handoffMayHaveBeenSent(error)
          ? backgroundText(
            "notifications",
            "ambiguousManual",
            "Firelink may have received the request. Check Firelink before trying again."
          )
          : error?.serverReached
          ? backgroundText(
            "notifications",
            "rejected",
            "Firelink rejected the request. No download was added."
          )
          : backgroundText(
            "notifications",
            "unavailable",
            "Firelink is unavailable. No download was added."
          )
      );
    }
    return false;
  }
}

function notifyAmbiguousAutomaticCapture() {
  notify(
    backgroundText("notifications", "ambiguousTitle", "Firelink Handoff Needs Attention"),
    backgroundText(
      "notifications",
      "ambiguousMessage",
      "Firelink may have received this download. The original was left paused to prevent a duplicate."
    )
  );
}

async function handleAutomaticCapture(
  downloadItem,
  filenameWait,
  pendingRecord = null,
  existingSession = null
) {
  const record = pendingRecord || createPendingCaptureRecord(downloadItem);
  const session = existingSession || beginAutomaticCapture(record.id);
  if (!session) {
    filenameWait?.cancel();
    return;
  }

  const abandonBeforeHandoff = async () => {
    if (session.handoffMayHaveBeenSent) {
      await markAmbiguousCapture(record.id);
      return;
    }
    if (session.downloadLookupFailed) {
      await updatePendingCapture(record.id, { phase: "ready" });
      schedulePendingCaptureRecovery();
      return;
    }
    if (automaticCaptureInvalidated(session)) {
      const removed = await removePendingCapture(record.id);
      if (!removed) {
        schedulePendingCaptureRecovery();
      }
      return;
    }
    await updatePendingCapture(record.id, { phase: "ready" });
    await removePendingCaptureAndResume(record.id, session);
  };

  try {
    if (!pendingRecord && !await savePendingCapture(record)) {
      await resumeAndForgetAutomaticCapture(record.id, session);
      return;
    }

    await settingsLoaded;

    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      if (filenameWait) {
        filenameWait.cancel();
      }
      await removePendingCaptureAndResume(record.id, session);
      return;
    }

    const filename = filenameWait
      ? await filenameWait.promise
      : record.filename;
    record.filename = filename || record.filename;
    const currentDownload = await findOwnedAutomaticDownload(record, session);
    if (!currentDownload) {
      await abandonBeforeHandoff();
      return;
    }
    if (typeof currentDownload.finalUrl === "string" && currentDownload.finalUrl) {
      record.finalUrl = currentDownload.finalUrl;
    }
    if (typeof currentDownload.mime === "string" && currentDownload.mime) {
      record.mime = currentDownload.mime;
    }
    const currentFilename = normalizeCaptureFilename(currentDownload.filename);
    if (isUsableCaptureFilename(currentFilename)) {
      record.filename = currentFilename;
    }
    const torrent = isTorrentDownload(currentDownload, record.filename)
      || isTorrentDownload(record, record.filename);
    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      await removePendingCaptureAndResume(record.id, session);
      return;
    }
    if (!await updatePendingCapture(record.id, {
      filename: record.filename,
      finalUrl: record.finalUrl,
      mime: record.mime,
      phase: "ready"
    })) {
      await resumeAndForgetAutomaticCapture(record.id, session);
      return;
    }
    if (!await updatePendingCapture(record.id, { phase: "sending" })) {
      await resumeAndForgetAutomaticCapture(record.id, session);
      return;
    }
    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)
      || !await findOwnedAutomaticDownload(record, session)) {
      await abandonBeforeHandoff();
      return;
    }

    const handoffPolicyRevision = capturePolicyRevision;
    let accepted = false;
    session.handoffStarted = true;
    try {
      accepted = await sendToFirelink(
        [record.url],
        record.referrer,
        {
          allowProtocolFallback: true,
          captureMode: "automatic",
          cookieStoreId: record.cookieStoreId,
          incognito: record.incognito,
          notifyOnFailure: false,
          filename: record.filename || undefined,
          torrent,
          onRequestMayHaveBeenSent: () => {
            session.handoffMayHaveBeenSent = true;
          }
        }
      );
    } catch (error) {
      session.handoffMayHaveBeenSent = true;
    }

    if (!accepted) {
      if (session.handoffMayHaveBeenSent) {
        await markAmbiguousCapture(record.id);
        return;
      }
      await abandonBeforeHandoff();
      return;
    }

    if (capturePolicyRevision !== handoffPolicyRevision
      || !automaticCaptureAllowedForDownload(record.url, record.referrer)
      || automaticCaptureInvalidated(session)) {
      // The request may already have reached Firelink. The safe outcome is to
      // keep the browser download paused and require the user to reconcile the
      // possible duplicate rather than canceling the only known original.
      await markAmbiguousCapture(record.id);
      return;
    }

    if (!await updatePendingCapture(record.id, { phase: "accepted" })) {
      await markAmbiguousCapture(record.id);
      return;
    }

    if (!await findOwnedAutomaticDownload(record, session)) {
      await markAmbiguousCapture(record.id);
      return;
    }

    let cleanupSucceeded = false;
    session.cleanupStarted = true;
    try {
      if (!automaticCaptureInvalidated(session)) {
        session.cleanupTerminalExpected = true;
        const cancelled = await runDownloadAction("cancel", record.id);
        if (cancelled && !session.userResumed && !session.terminal) {
          const erased = await runDownloadAction("erase", { id: record.id });
          if (erased && !session.userResumed && !session.terminal) {
            cleanupSucceeded = true;
          }
        }
      }
    } finally {
      session.cleanupStarted = false;
    }
    if (!cleanupSucceeded || automaticCaptureInvalidated(session)) {
      await markAmbiguousCapture(record.id);
      return;
    }
    const removed = await removePendingCapture(record.id);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    notify(
      backgroundText("notifications", "captureTitle", "Firelink Download Capture"),
      backgroundText(
        "notifications",
        "captureMessage",
        "Download automatically forwarded to Firelink."
      )
    );
  } finally {
    activeAutomaticCaptures.delete(record.id);
  }
}

async function recoverPendingCaptures() {
  if (pendingCaptureRecovery) {
    return pendingCaptureRecovery;
  }

  pendingCaptureRecovery = (async () => {
    await settingsLoaded;
    let pending;
    try {
      pending = await readPendingCaptureMap();
    } catch (error) {
      schedulePendingCaptureRecovery();
      return;
    }
    for (const record of Object.values(pending)) {
      if (activeAutomaticCaptures.has(record.id)) {
        continue;
      }
      const session = beginAutomaticCapture(record.id);
      if (!session) {
        continue;
      }
      try {
        let downloadItem;
        try {
          downloadItem = await findDownload(record.id);
        } catch (error) {
          schedulePendingCaptureRecovery();
          continue;
        }
        if (!downloadItem) {
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }
        if (!pendingCaptureMatchesDownload(record, downloadItem)) {
          // Download IDs are browser-owned identifiers, not a durable Firelink
          // identity. Never pause, cancel, or erase a different item that now
          // occupies a stale persisted ID.
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }

        if (record.phase === "accepted") {
          if (isTerminalDownload(downloadItem)
            || downloadItem.paused !== true
            || automaticCaptureInvalidated(session)) {
            await markAmbiguousCapture(record.id);
            continue;
          }

          let cleanupSucceeded = false;
          session.cleanupStarted = true;
          try {
            if (!automaticCaptureInvalidated(session)) {
              session.cleanupTerminalExpected = true;
              const cancelled = await runDownloadAction("cancel", record.id);
              if (cancelled && !session.userResumed && !session.terminal) {
                const erased = await runDownloadAction("erase", { id: record.id });
                if (erased && !session.userResumed && !session.terminal) {
                  cleanupSucceeded = true;
                }
              }
            }
          } finally {
            session.cleanupStarted = false;
          }
          if (!cleanupSucceeded || automaticCaptureInvalidated(session)) {
            await markAmbiguousCapture(record.id);
            continue;
          }
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }

        if (record.phase === "sending") {
          await markAmbiguousCapture(record.id);
          continue;
        }

        if (record.phase === "uncertain") {
          continue;
        }

        // A terminal item cannot be resumed, even if capture was disabled
        // while the worker was asleep.
        if (isTerminalDownload(downloadItem)) {
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }

        if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
          if (downloadItem.paused === true) {
            if (automaticCaptureInvalidated(session)) {
              const removed = await removePendingCapture(record.id);
              if (!removed) {
                schedulePendingCaptureRecovery();
              }
              continue;
            }
            let resumed = false;
            session.cleanupStarted = true;
            try {
              resumed = await runDownloadAction("resume", record.id);
            } finally {
              session.cleanupStarted = false;
            }
            if (!resumed && !session.userResumed && !session.terminal) {
              if (!await updatePendingCapture(record.id, { phase: "ready" })) {
                schedulePendingCaptureRecovery();
              }
              continue;
            }
          }
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }

        if (automaticCaptureInvalidated(session)) {
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }
        if (downloadItem.paused !== true) {
          // A persisted record means this extension already claimed and paused
          // the item. If it is now running, treat that as an external release
          // (including a user resume) rather than pausing and recapturing it.
          const removed = await removePendingCapture(record.id);
          if (!removed) {
            schedulePendingCaptureRecovery();
          }
          continue;
        }
        const recoveredDownloadItem = {
          ...downloadItem,
          url: record.url,
          finalUrl: typeof downloadItem.finalUrl === "string"
            ? downloadItem.finalUrl
            : record.finalUrl,
          referrer: record.referrer,
          filename: isUsableCaptureFilename(downloadItem.filename)
            ? normalizeCaptureFilename(downloadItem.filename)
            : record.filename,
          cookieStoreId: record.cookieStoreId,
          incognito: record.incognito
        };
        await handleAutomaticCapture(
          recoveredDownloadItem,
          waitForDownloadFilename(recoveredDownloadItem),
          record,
          session
        );
      } finally {
        activeAutomaticCaptures.delete(record.id);
      }
    }
  })().finally(() => {
    pendingCaptureRecovery = null;
  });

  return pendingCaptureRecovery;
}

async function fetchMediaForTab(tab, options = {}) {
  const pageURL = options.preferSrcUrl === true
    ? normalizePageMediaURL(options.srcUrl) || normalizePageMediaURL(tab?.url)
    : normalizePageMediaURL(tab?.url) || normalizePageMediaURL(options.srcUrl);
  if (!pageURL) {
    if (options.notifyOnFailure !== false) {
      notify(
        backgroundText("notifications", "mediaTitle", "Firelink Media Fetch"),
        backgroundText(
          "notifications",
          "mediaOpenPage",
          "Open a normal web page, then try Fetch media again."
        )
      );
    }
    return { accepted: false, ambiguous: false };
  }

  let requestMayHaveBeenSent = false;
  let accepted = false;
  try {
    accepted = await sendToFirelink([pageURL], pageURL, {
      allowProtocolFallback: true,
      cookieStoreId: tab?.cookieStoreId,
      incognito: tab?.incognito === true,
      // yt-dlp handles media cookies through Firelink's configured browser
      // source. A full page Cookie header can exceed YouTube's request limit.
      forwardCookies: false,
      includeUserAgent: false,
      media: true,
      notifyOnFailure: options.notifyOnFailure !== false,
      onRequestMayHaveBeenSent: () => {
        requestMayHaveBeenSent = true;
      }
    });
  } catch (error) {
    // An unexpected failure after the page was handed to the transport is
    // still ambiguous. The caller must not blindly retry a possible media
    // admission or tell the browser to proceed as though nothing happened.
    requestMayHaveBeenSent = true;
    if (options.notifyOnFailure !== false) {
      notify(
        backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
        backgroundText(
          "notifications",
          "ambiguousManual",
          "Firelink may have received the request. Check Firelink before trying again."
        )
      );
    }
  }

  if (accepted && options.notifyOnSuccess === true) {
    notify(
      backgroundText("notifications", "mediaTitle", "Firelink Media Fetch"),
      backgroundText("notifications", "mediaSent", "Media page sent to Firelink.")
    );
  }

  return {
    accepted,
    ambiguous: requestMayHaveBeenSent && !accepted
  };
}

async function openAutomaticMagnetFallback(url, sender, openInNewTab = false) {
  if (openInNewTab && chrome.tabs?.create) {
    const result = await callExtensionApi(chrome.tabs, "create", [{ url, active: true }]);
    return result.ok;
  }

  const tabId = sender?.tab?.id;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !chrome.tabs?.update) {
    return false;
  }
  const result = await callExtensionApi(chrome.tabs, "update", [tabId, { url }]);
  return result.ok;
}

async function captureAutomaticMagnet(request, sender) {
  const url = normalizeURL(request?.url || request?.href);
  if (!url || !isMagnetURL(url)) {
    return { intercepted: false };
  }

  const referer = typeof sender?.tab?.url === "string" ? sender.tab.url : "";
  await settingsLoaded;
  if (!automaticCaptureAllowedForDownload(url, referer)) {
    const fallback = await openAutomaticMagnetFallback(
      url,
      sender,
      request?.openInNewTab === true
    );
    return { intercepted: fallback, fallback, ambiguous: false };
  }

  let requestMayHaveBeenSent = false;
  let accepted = false;
  try {
    accepted = await sendToFirelink([url], referer, {
      allowProtocolFallback: true,
      captureMode: "automatic",
      cookieStoreId: sender?.tab?.cookieStoreId,
      incognito: sender?.tab?.incognito === true,
      notifyOnFailure: false,
      torrent: true,
      onRequestMayHaveBeenSent: () => {
        requestMayHaveBeenSent = true;
      }
    });
  } catch (error) {
    // A failure outside sendToFirelink's classified protocol paths is still
    // conservative: the click was already suppressed, so do not replay it
    // unless the handoff definitely did not get as far as the receiver.
    requestMayHaveBeenSent = true;
  }

  const ambiguous = requestMayHaveBeenSent && !accepted;
  if (ambiguous) {
    notify(
      backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
      backgroundText(
        "notifications",
        "ambiguousManual",
        "Firelink may have received the request. Check Firelink before trying again."
      )
    );
  }

  if (!accepted && !ambiguous) {
    const fallback = await openAutomaticMagnetFallback(
      url,
      sender,
      request?.openInNewTab === true
    );
    return { intercepted: fallback, fallback, ambiguous: false };
  }

  return {
    intercepted: accepted || requestMayHaveBeenSent,
    ambiguous
  };
}

function sendSelectionTextLinks(info, tab) {
  const urls = extractURLsFromText(info.selectionText);
  if (urls.length === 0) {
    return false;
  }
  sendContextMenuHandoff(urls, tab?.url || "", {
    cookieStoreId: tab?.cookieStoreId,
    incognito: tab?.incognito === true,
    batch: true,
    batchName: tab?.title
  });
  return true;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "captureAutomaticMagnet") {
    captureAutomaticMagnet(request, _sender)
      .then(result => sendResponse(result))
      .catch(() => {
        // The content script already suppressed the user click. An unknown
        // background failure must fail closed rather than replaying a magnet
        // that may have reached Firelink before the failure surfaced.
        notify(
          backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
          backgroundText(
            "notifications",
            "ambiguousManual",
            "Firelink may have received the request. Check Firelink before trying again."
          )
        );
        sendResponse({ intercepted: true, ambiguous: true });
      });
    return true;
  }

  if (request?.action === "reportAutomaticMagnetTimeout") {
    notify(
      backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
      backgroundText(
        "notifications",
        "ambiguousManual",
        "Firelink may have received the request. Check Firelink before trying again."
      )
    );
    return false;
  }

  if (request?.action !== "fetchMediaForActiveTab") {
    return false;
  }

  void callExtensionApi(chrome.tabs, "query", [{ active: true, currentWindow: true }])
    .then(result => {
      if (!result.ok) {
        sendResponse({ ok: false });
        return;
      }
      const tab = Array.isArray(result.value) ? result.value[0] || null : null;
      return fetchMediaForTab(tab, { notifyOnSuccess: false })
        .then(result => sendResponse({
          ok: result.accepted,
          ambiguous: result.ambiguous
        }))
        .catch(() => sendResponse({ ok: false }));
    })
    .catch(() => sendResponse({ ok: false }));
  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || typeof info !== "object") {
    return;
  }
  if (info.menuItemId === "download-with-firelink") {
    if (info.linkUrl) {
      sendContextMenuHandoff([info.linkUrl], tab?.url || "", {
        cookieStoreId: tab?.cookieStoreId,
        incognito: tab?.incognito === true
      });
    }
    return;
  }

  if (info.menuItemId === "fetch-media-with-firelink") {
    void fetchMediaForTab(tab, {
      srcUrl: info.linkUrl || info.srcUrl,
      preferSrcUrl: Boolean(info.linkUrl),
      notifyOnSuccess: true
    }).catch(error => reportContextMenuHandoffFailure("media context-menu", error));
    return;
  }

  if (info.menuItemId !== "download-selected-with-firelink") {
    return;
  }

  if (!Number.isSafeInteger(tab?.id) || tab.id < 0
    || !chrome.scripting?.executeScript || !chrome.tabs?.sendMessage) {
    sendSelectionTextLinks(info, tab);
    return;
  }

  void callExtensionApi(chrome.scripting, "executeScript", [{
    target: { tabId: tab.id },
    files: ["content.js"]
  }]).then(injected => {
    if (!injected.ok) {
      sendSelectionTextLinks(info, tab);
      return;
    }

    return callExtensionApi(chrome.tabs, "sendMessage", [
      tab.id,
      { action: "extractSelectionLinks" }
    ]).then(result => {
      const response = result.ok ? result.value : null;
      if (Array.isArray(response?.links) && response.links.length > 0) {
        sendContextMenuHandoff(response.links, tab?.url || "", {
          cookieStoreId: tab?.cookieStoreId,
          incognito: tab?.incognito === true,
          batch: true,
          batchName: tab?.title
        });
        return;
      }

      sendSelectionTextLinks(info, tab);
    });
  }).catch(() => {
    sendSelectionTextLinks(info, tab);
  });
});

function runDownloadAction(action, ...args) {
  return new Promise(resolve => {
    const method = chrome.downloads?.[action];
    if (typeof method !== "function") {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = success => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(success);
    };
    try {
      const result = method.call(chrome.downloads, ...args, () => {
        finish(!chrome.runtime?.lastError);
      });
      if (result && typeof result.then === "function") {
        result.then(() => finish(true), () => finish(false));
      }
    } catch (error) {
      finish(false);
    }
  });
}

function downloadChangeFields(change) {
  const fields = {};
  const changedFinalUrl = change.finalUrl?.current;
  if (typeof changedFinalUrl === "string" && changedFinalUrl) {
    fields.finalUrl = changedFinalUrl;
  }
  const filename = change.filename?.current;
  if (filename !== undefined && isUsableCaptureFilename(filename)) {
    fields.filename = normalizeCaptureFilename(filename);
  }
  return fields;
}

async function reconcilePendingDownloadChange(change, downloadItem, fields, resumed, terminal) {
  let pending;
  try {
    pending = await readPendingCaptureMap();
  } catch (error) {
    schedulePendingCaptureRecovery();
    return;
  }
  const record = pending[String(change.id)];
  if (!record || !pendingCaptureMatchesDownload(record, downloadItem)) {
    return;
  }

  await mutatePendingCaptureMap(current => {
    const currentRecord = current[String(change.id)];
    if (!currentRecord || !pendingCaptureMatchesDownload(currentRecord, downloadItem)) {
      return current;
    }
    if (!resumed && !terminal) {
      return Object.keys(fields).length > 0
        ? {
          ...current,
          [String(change.id)]: { ...currentRecord, ...fields, updatedAt: Date.now() }
        }
        : current;
    }
    if (["sending", "accepted", "uncertain"].includes(currentRecord.phase)) {
      return currentRecord.phase === "sending"
        ? {
          ...current,
          [String(change.id)]: {
            ...currentRecord,
            ...fields,
            phase: "uncertain",
            updatedAt: Date.now()
          }
        }
        : current;
    }
    const next = { ...current };
    delete next[String(change.id)];
    return next;
  });
}

chrome.downloads.onChanged.addListener(change => {
  if (!change || typeof change !== "object"
    || !Number.isSafeInteger(change.id) || change.id < 0) {
    return;
  }
  const fields = downloadChangeFields(change);
  const filename = change.filename?.current;
  if (filename !== undefined && isUsableCaptureFilename(filename)) {
    settleDownloadFilenameWait(change.id, filename);
  }
  const state = change.state?.current;
  const resumed = change.paused?.current === false;
  const terminal = state === "complete" || state === "interrupted";
  if (resumed || terminal) {
    settleDownloadFilenameWait(change.id);
  }

  const active = activeAutomaticCaptures.has(change.id);
  if (active) {
    if (Object.keys(fields).length > 0) {
      void updatePendingCapture(change.id, fields).catch(() => {});
    }
    if (resumed || terminal) {
      noteAutomaticCaptureChange(change.id, {
        resumed,
        terminal,
        terminalState: state
      });
    }
    return;
  }

  // A browser download ID is not a durable identity. Before changing a
  // persisted record, inspect the current item and verify its source and
  // creation identity; otherwise a stale event for a reused ID could mutate
  // or delete an unrelated download's record.
  void findDownload(change.id)
    .then(downloadItem => {
      if (!downloadItem) {
        return;
      }
      return reconcilePendingDownloadChange(change, downloadItem, fields, resumed, terminal);
    })
    .catch(() => {
      schedulePendingCaptureRecovery();
    });
});

chrome.downloads.onCreated.addListener(async downloadItem => {
  if (!downloadItem || typeof downloadItem !== "object"
    || !Number.isSafeInteger(downloadItem.id) || downloadItem.id < 0) {
    return;
  }
  const session = beginAutomaticCapture(downloadItem?.id);
  if (!session) {
    return;
  }
  const filenameWait = waitForDownloadFilename(downloadItem);

  await settingsLoaded;
  if (!automaticCaptureAllowedForDownload(downloadItem.url, downloadItem.referrer)) {
    activeAutomaticCaptures.delete(downloadItem.id);
    filenameWait.cancel();
    return;
  }

  if (automaticCaptureInvalidated(session)) {
    activeAutomaticCaptures.delete(downloadItem.id);
    filenameWait.cancel();
    return;
  }
  const record = createPendingCaptureRecord(downloadItem);
  if (!await savePendingCapture(record)) {
    // The pause has not happened yet. Do not delete an older record that may
    // occupy a reused browser ID when the failed write never reached storage.
    // If the browser reported a write failure after persisting the new record,
    // the next recovery pass will see the still-running item and clear it
    // without pausing or recapturing it.
    schedulePendingCaptureRecovery();
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }
  // Ownership is durable before the pause, but a user resume or terminal
  // event may have arrived while that write was in flight. Never let the
  // initial pause overwrite that newer browser state.
  if (automaticCaptureInvalidated(session)
    || !automaticCaptureAllowedForDownload(record.url, record.referrer)) {
    const removed = await removePendingCapture(record.id);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }

  const paused = await runDownloadAction("pause", downloadItem.id);
  if (!paused) {
    await removePendingCaptureAndResume(record.id, session);
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }
  // A resume can race with the pause RPC itself. If the browser reported user
  // intent while that RPC was in flight, restore it before any handoff work;
  // otherwise the extension could leave a user-resumed download paused.
  if (automaticCaptureInvalidated(session)) {
    if (session.userResumed && !session.terminal && !session.downloadMissing) {
      await removePendingCaptureAndResume(record.id, session);
    } else {
      const removed = await removePendingCapture(record.id);
      if (!removed) {
        schedulePendingCaptureRecovery();
      }
    }
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }
  await handleAutomaticCapture(downloadItem, filenameWait, record, session);
});

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === PENDING_CAPTURE_RECOVERY_ALARM) {
      void recoverPendingCaptures();
    }
  });
}

void recoverPendingCaptures();
