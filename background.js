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
const PENDING_CAPTURE_STORAGE_KEY = "pendingAutomaticCaptures";
const PENDING_CAPTURE_RECOVERY_ALARM = "firelink-pending-capture-recovery";
const PENDING_CAPTURE_RECOVERY_DELAY_MS = 30_000;
let launchSession = null;
let launchCleanup = Promise.resolve();
const pendingDownloadFilenameWaits = new Map();
let pendingCaptureMutation = Promise.resolve();
let pendingCaptureRecovery = null;
const activeAutomaticCaptures = new Set();
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

const truncateByCodePoints = (value, maxCodePoints) =>
  Array.from(value).slice(0, maxCodePoints).join("");

const reportContextMenuHandoffFailure = (action, error) => {
  console.error(`Firelink ${action} handoff failed:`, error);
};

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
      cachedSettings.siteToggles = result.siteToggles;
    }
    if (result.extensionToken !== undefined && !settingsChangedDuringLoad.has("extensionToken")) {
      cachedSettings.extensionToken = result.extensionToken;
    }
    if (result.language !== undefined && !settingsChangedDuringLoad.has("language")) {
      cachedSettings.language = result.language;
    }
    if (result.launchTimeoutCount !== undefined && !settingsChangedDuringLoad.has("launchTimeoutCount")) {
      cachedSettings.launchTimeoutCount = result.launchTimeoutCount;
    }
    if (result.launchCooldownUntil !== undefined && !settingsChangedDuringLoad.has("launchCooldownUntil")) {
      cachedSettings.launchCooldownUntil = result.launchCooldownUntil;
    }
    settingsLoadInProgress = false;
    resolve();
  };

  try {
    chrome.storage.local.get(SETTINGS_KEYS, finish);
  } catch (error) {
    finish({});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) {
      continue;
    }
    if (settingsLoadInProgress) {
      settingsChangedDuringLoad.add(key);
    }
    cachedSettings[key] = changes[key].newValue;
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
    .then(() => new Promise(resolve => {
      if (!chrome.contextMenus?.removeAll || !chrome.contextMenus?.create) {
        resolve();
        return;
      }

      chrome.contextMenus.removeAll(() => {
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
            contexts: ["page", "video", "audio"]
          }
        ];
        for (const item of items) {
          try {
            chrome.contextMenus.create(item);
          } catch (error) {
            console.error("Firelink context menu registration failed:", error);
          }
        }
        resolve();
      });
    }));
  return contextMenuRegistration;
}

void settingsLoaded.then(registerContextMenus);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    SETTINGS_KEYS,
    result => {
      result = result && typeof result === "object" ? result : {};
      const missingSettings = {};
      for (const [key, value] of Object.entries(defaultSettings)) {
        if (result[key] === undefined) {
          missingSettings[key] = value;
        }
      }
      if (Object.keys(missingSettings).length > 0) {
        chrome.storage.local.set(missingSettings);
      }
    }
  );
  void settingsLoaded.then(registerContextMenus);
});

function normalizeURL(rawURL) {
  if (typeof rawURL !== "string") {
    return null;
  }

  let trimmed = rawURL.trim();
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

  try {
    const url = new URL(trimmed);
    return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
  } catch (error) {
    return null;
  }
}

function extractURLsFromText(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(/(?:\b(?:https?|ftp|sftp):\/\/[^\s<>"']+|\bmagnet:\?[^\s<>"']+)/gi) || [];
  return [...new Set(matches.map(normalizeURL).filter(Boolean))];
}

function normalizeURLList(urls) {
  const rawURLs = Array.isArray(urls) ? urls : [urls];
  return [...new Set(rawURLs.map(normalizeURL).filter(Boolean))];
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
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message
  });
}

function createLaunchTab() {
  return new Promise(resolve => {
    chrome.tabs.create({ url: LAUNCH_URL, active: true }, tab => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab?.id ?? null);
    });
  });
}

function closeLaunchTab(tabId) {
  if (tabId === null || tabId === undefined || !chrome.tabs.remove) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePendingCaptureMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([id, record]) => (
      /^\d+$/.test(id)
      && record
      && typeof record === "object"
      && typeof record.url === "string"
      && record.url.length > 0
      && ["paused", "ready", "sending", "accepted", "uncertain"].includes(record.phase)
    ))
  );
}

function readPendingCaptureMap() {
  if (!chrome.storage?.local?.get) {
    return Promise.resolve({});
  }

  return new Promise(resolve => {
    try {
      chrome.storage.local.get([PENDING_CAPTURE_STORAGE_KEY], result => {
        resolve(normalizePendingCaptureMap(result?.[PENDING_CAPTURE_STORAGE_KEY]));
      });
    } catch (error) {
      resolve({});
    }
  });
}

function writePendingCaptureMap(value) {
  if (!chrome.storage?.local?.set) {
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(!chrome.runtime?.lastError);
    };

    try {
      const result = chrome.storage.local.set({
        [PENDING_CAPTURE_STORAGE_KEY]: normalizePendingCaptureMap(value)
      }, finish);
      if (result && typeof result.then === "function") {
        result.then(finish, () => resolve(false));
      }
    } catch (error) {
      finish();
    }
  });
}

function schedulePendingCaptureRecovery() {
  if (!chrome.alarms?.create) {
    return;
  }
  try {
    chrome.alarms.create(PENDING_CAPTURE_RECOVERY_ALARM, {
      when: Date.now() + PENDING_CAPTURE_RECOVERY_DELAY_MS
    });
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
  await updatePendingCapture(recordId, { phase: "uncertain" });
  notifyAmbiguousAutomaticCapture();
}

async function removePendingCaptureAndResume(recordId) {
  const removed = await removePendingCapture(recordId);
  await runDownloadAction("resume", recordId);
  return removed;
}

function findDownload(downloadId) {
  if (!chrome.downloads?.search) {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    try {
      chrome.downloads.search({ id: downloadId }, items => resolve(items?.[0] || null));
    } catch (error) {
      resolve(null);
    }
  });
}

function storeLaunchState(timeoutCount, cooldownUntil) {
  cachedSettings.launchTimeoutCount = timeoutCount;
  cachedSettings.launchCooldownUntil = cooldownUntil;
  chrome.storage.local.set({
    launchTimeoutCount: timeoutCount,
    launchCooldownUntil: cooldownUntil
  });
}

async function waitForFirelink(token, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await FirelinkProtocol.signedFetch("/ping", token);
      return true;
    } catch (error) {
      lastError = error;
      if (error.serverReached && error.status === 403) {
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
      if (error.status === 503 && error.serverReached) {
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
    if (launchFailed) {
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
    const cookies = await new Promise(resolve => {
      const details = cookieStoreId ? { url, storeId: cookieStoreId } : { url };
      chrome.cookies.getAll(details, resolve);
    });
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
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

function reportAmbiguousHandoff(options, error) {
  const requestMayHaveBeenSent = error?.requestMayHaveBeenSent === true
    || (error?.serverReached === true && error?.status === 504);
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
    const stores = await new Promise(resolve => {
      chrome.cookies.getAllCookieStores(resolve);
    });
    return stores?.find(store => store.incognito)?.id || null;
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

function isTorrentDownload(downloadItem, filename) {
  return isTorrentFilename(filename)
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
  const isTorrent = normalizedURLs.length === 1
    && (options.torrent === true || containsTorrentURL);
  const payload = {
    urls: normalizedURLs,
    referer,
    silent: captureMode === "automatic",
    filename: options.filename,
    headers: options.includeUserAgent === false ? undefined : `User-Agent: ${navigator.userAgent}`,
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

  const requiredProtocolVersion = (isTorrent || containsTorrentURL || options.torrent === true)
    ? TORRENT_CAPTURE_PROTOCOL_VERSION
    : options.media === true
    ? MEDIA_FETCH_PROTOCOL_VERSION
    : captureMode === "automatic" ? 3 : undefined;

  try {
    await FirelinkProtocol.signedFetch("/download", cachedSettings.extensionToken, {
      method: "POST",
      payload,
      requiredProtocolVersion
    });
    return true;
  } catch (error) {
    if (error.serverReached && error.status === 426) {
      if (notifyOnFailure) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: backgroundText("notifications", "updateTitle", "Firelink Update Required"),
          message: backgroundText(
            "notifications",
            "updateMessage",
            "Update the Firelink desktop app to use browser integration."
          )
        });
      }
      return false;
    }

    if (error.serverReached && error.status === 403) {
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

    if (error.serverReached && error.status === 503) {
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
            backgroundText(
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
      && !error.serverReached
      && !error.requestMayHaveBeenSent;
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
        error.serverReached
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
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: backgroundText("notifications", "ambiguousTitle", "Firelink Handoff Needs Attention"),
    message: backgroundText(
      "notifications",
      "ambiguousMessage",
      "Firelink may have received this download. The original was left paused to prevent a duplicate."
    )
  });
}

async function handleAutomaticCapture(downloadItem, filenameWait, pendingRecord = null) {
  const record = pendingRecord || createPendingCaptureRecord(downloadItem);
  activeAutomaticCaptures.add(record.id);
  try {
    if (!pendingRecord && !await savePendingCapture(record)) {
      await runDownloadAction("resume", record.id);
      return;
    }

    await settingsLoaded;

    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      if (filenameWait) {
        filenameWait.cancel();
      }
      await removePendingCaptureAndResume(record.id);
      return;
    }

    const filename = filenameWait
      ? await filenameWait.promise
      : record.filename;
    record.filename = filename || record.filename;
    const currentDownload = await findDownload(record.id);
    if (typeof currentDownload?.finalUrl === "string" && currentDownload.finalUrl) {
      record.finalUrl = currentDownload.finalUrl;
    }
    const torrent = isTorrentDownload(record, record.filename);
    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      await removePendingCaptureAndResume(record.id);
      return;
    }
    if (!await updatePendingCapture(record.id, {
      filename: record.filename,
      phase: "ready"
    })) {
      await runDownloadAction("resume", record.id);
      return;
    }
    if (!await updatePendingCapture(record.id, { phase: "sending" })) {
      await runDownloadAction("resume", record.id);
      return;
    }
    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      await updatePendingCapture(record.id, { phase: "ready" });
      await removePendingCaptureAndResume(record.id);
      return;
    }

    const handoffPolicyRevision = capturePolicyRevision;
    let handoffMayHaveBeenSent = false;
    let accepted = false;
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
            handoffMayHaveBeenSent = true;
          }
        }
      );
    } catch (error) {
      handoffMayHaveBeenSent = true;
    }

    if (!accepted) {
      if (handoffMayHaveBeenSent) {
        await markAmbiguousCapture(record.id);
        return;
      }
      await updatePendingCapture(record.id, { phase: "ready" });
      await removePendingCaptureAndResume(record.id);
      return;
    }

    if (capturePolicyRevision !== handoffPolicyRevision
      || !automaticCaptureAllowedForDownload(record.url, record.referrer)) {
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
    await runDownloadAction("cancel", record.id);
    await runDownloadAction("erase", { id: record.id });
    await removePendingCapture(record.id);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: backgroundText("notifications", "captureTitle", "Firelink Download Capture"),
      message: backgroundText(
        "notifications",
        "captureMessage",
        "Download automatically forwarded to Firelink."
      )
    });
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
    const pending = await readPendingCaptureMap();
    for (const record of Object.values(pending)) {
      if (activeAutomaticCaptures.has(record.id)) {
        continue;
      }
      const downloadItem = await findDownload(record.id);
      if (!downloadItem) {
        await removePendingCapture(record.id);
        continue;
      }

      if (record.phase === "accepted") {
        await runDownloadAction("cancel", record.id);
        await runDownloadAction("erase", { id: record.id });
        await removePendingCapture(record.id);
        continue;
      }

      if (record.phase === "sending") {
        await markAmbiguousCapture(record.id);
        continue;
      }

      if (record.phase === "uncertain") {
        continue;
      }

      if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
        await removePendingCapture(record.id);
        if (downloadItem.paused === true) {
          await runDownloadAction("resume", record.id);
        }
        continue;
      }

      const paused = await runDownloadAction("pause", record.id);
      if (!paused) {
        await removePendingCapture(record.id);
        continue;
      }
      await handleAutomaticCapture(
        {
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
        },
        null,
        record
      );
    }
  })().finally(() => {
    pendingCaptureRecovery = null;
  });

  return pendingCaptureRecovery;
}

async function fetchMediaForTab(tab, options = {}) {
  const pageURL = normalizePageMediaURL(tab?.url) || normalizePageMediaURL(options.srcUrl);
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
    return false;
  }

  const accepted = await sendToFirelink([pageURL], pageURL, {
    allowProtocolFallback: true,
    cookieStoreId: tab?.cookieStoreId,
    incognito: tab?.incognito === true,
    // yt-dlp handles media cookies through Firelink's configured browser
    // source. A full page Cookie header can exceed YouTube's request limit.
    forwardCookies: false,
    includeUserAgent: false,
    media: true,
    notifyOnFailure: options.notifyOnFailure !== false
  });

  if (accepted && options.notifyOnSuccess === true) {
    notify(
      backgroundText("notifications", "mediaTitle", "Firelink Media Fetch"),
      backgroundText("notifications", "mediaSent", "Media page sent to Firelink.")
    );
  }

  return accepted;
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
  if (request?.action !== "fetchMediaForActiveTab") {
    return false;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs?.[0] || null;
    fetchMediaForTab(tab, { notifyOnSuccess: false })
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
  });
  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
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
      srcUrl: info.srcUrl,
      notifyOnSuccess: true
    }).catch(error => reportContextMenuHandoffFailure("media context-menu", error));
    return;
  }

  if (info.menuItemId !== "download-selected-with-firelink") {
    return;
  }

  if (!tab?.id || !chrome.scripting?.executeScript || !chrome.tabs?.sendMessage) {
    sendSelectionTextLinks(info, tab);
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      files: ["content.js"]
    },
    () => {
      if (chrome.runtime.lastError) {
        sendSelectionTextLinks(info, tab);
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        { action: "extractSelectionLinks" },
        response => {
          if (chrome.runtime.lastError) {
            sendSelectionTextLinks(info, tab);
            return;
          }

          if (response?.links?.length > 0) {
            sendContextMenuHandoff(response.links, tab?.url || "", {
              cookieStoreId: tab?.cookieStoreId,
              incognito: tab?.incognito === true,
              batch: true,
              batchName: tab?.title
            });
            return;
          }

          sendSelectionTextLinks(info, tab);
        }
      );
    }
  );
});

function runDownloadAction(action, ...args) {
  return new Promise(resolve => {
    chrome.downloads[action](...args, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

chrome.downloads.onChanged.addListener(change => {
  const changedFinalUrl = change.finalUrl?.current;
  if (typeof changedFinalUrl === "string" && changedFinalUrl) {
    void updatePendingCapture(change.id, { finalUrl: changedFinalUrl }).catch(() => {});
  }
  const filename = change.filename?.current;
  if (filename !== undefined && isUsableCaptureFilename(filename)) {
    settleDownloadFilenameWait(change.id, filename);
  }
  const state = change.state?.current;
  if (state && state !== "paused") {
    void mutatePendingCaptureMap(current => {
      const record = current[String(change.id)];
      if (!record || activeAutomaticCaptures.has(change.id)) {
        return current;
      }
      const next = { ...current };
      delete next[String(change.id)];
      return next;
    }).catch(() => {});
  }
});

chrome.downloads.onCreated.addListener(async downloadItem => {
  const filenameWait = waitForDownloadFilename(downloadItem);
  await settingsLoaded;
  if (!automaticCaptureAllowedForDownload(downloadItem.url, downloadItem.referrer)) {
    filenameWait.cancel();
    return;
  }

  const paused = await runDownloadAction("pause", downloadItem.id);
  if (!paused) {
    filenameWait.cancel();
    return;
  }
  await handleAutomaticCapture(downloadItem, filenameWait);
});

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === PENDING_CAPTURE_RECOVERY_ALARM) {
      void recoverPendingCaptures();
    }
  });
}

void recoverPendingCaptures();
