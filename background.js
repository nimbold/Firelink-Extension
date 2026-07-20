const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);
const PAGE_MEDIA_SCHEMES = new Set(["http:", "https:"]);

const defaultSettings = {
  globalCapture: true,
  siteToggles: {},
  extensionToken: "",
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

const settingsLoaded = new Promise(resolve => {
  chrome.storage.local.get(
    ["globalCapture", "siteToggles", "extensionToken", "launchTimeoutCount", "launchCooldownUntil"],
    result => {
      result = result && typeof result === "object" ? result : {};
      if (result.globalCapture !== undefined) {
        cachedSettings.globalCapture = result.globalCapture;
      }
      if (result.siteToggles !== undefined) {
        cachedSettings.siteToggles = result.siteToggles;
      }
      if (result.extensionToken !== undefined) {
        cachedSettings.extensionToken = result.extensionToken;
      }
      if (result.launchTimeoutCount !== undefined) {
        cachedSettings.launchTimeoutCount = result.launchTimeoutCount;
      }
      if (result.launchCooldownUntil !== undefined) {
        cachedSettings.launchCooldownUntil = result.launchCooldownUntil;
      }
      resolve();
    }
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.globalCapture) {
    cachedSettings.globalCapture = changes.globalCapture.newValue;
  }
  if (changes.siteToggles) {
    cachedSettings.siteToggles = changes.siteToggles.newValue;
  }
  if (changes.extensionToken) {
    cachedSettings.extensionToken = changes.extensionToken.newValue;
  }
  if (changes.launchTimeoutCount) {
    cachedSettings.launchTimeoutCount = changes.launchTimeoutCount.newValue;
  }
  if (changes.launchCooldownUntil) {
    cachedSettings.launchCooldownUntil = changes.launchCooldownUntil.newValue;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    ["globalCapture", "siteToggles", "extensionToken", "launchTimeoutCount", "launchCooldownUntil"],
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

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "download-with-firelink",
      title: "Download with Firelink",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "download-selected-with-firelink",
      title: "Download selected with Firelink",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "fetch-media-with-firelink",
      title: "Fetch media with Firelink",
      contexts: ["page", "video", "audio"]
    });
  });
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
  const matches = text.match(/\b(?:https?|ftp|sftp):\/\/[^\s<>"']+/gi) || [];
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
    return true;
  }
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
  return mutatePendingCaptureMap(current => {
    const existing = current[String(recordId)];
    if (!existing) {
      return current;
    }
    return {
      ...current,
      [String(recordId)]: { ...existing, ...changes, updatedAt: Date.now() }
    };
  }).then(() => true, () => false);
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
        "Firelink Was Not Opened",
        cooldownUntil
          ? "Your browser could not open Firelink. Check protocol permission, open Firelink once, then retry."
          : "Approve your browser's prompt to open Firelink. No download was added."
      );
    } else {
      storeLaunchState(0, 0);
      if (deliveryFailed) {
        notify("Firelink Handoff Failed", "Firelink opened but rejected a download request. No duplicate request was sent.");
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
        notify("Firelink Setup Required", "Please click the Firelink extension icon and paste the pairing token.");
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

  const requiredProtocolVersion = options.media === true
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
          title: "Firelink Update Required",
          message: "Update the Firelink desktop app to use browser integration."
        });
      }
      return false;
    }

    if (error.serverReached && error.status === 403) {
      if (notifyOnFailure) {
        notify("Firelink Connection Rejected", "Your pairing token is invalid. Update it in the Firelink extension popup.");
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
          notify("Firelink Handoff Failed", "Firelink started but was not ready to accept the download.");
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
            "Firelink Launch Needs Attention",
            "Open Firelink manually and confirm your browser is allowed to open firelink links, then retry."
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
        "Firelink Handoff Failed",
        error.serverReached
          ? "Firelink rejected the request. No download was added."
          : "Firelink is unavailable. No download was added."
      );
    }
    return false;
  }
}

function notifyAmbiguousAutomaticCapture() {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Firelink Handoff Needs Attention",
    message: "Firelink may have received this download. The original was left paused to prevent a duplicate."
  });
}

async function handleAutomaticCapture(downloadItem, filenameWait, pendingRecord = null) {
  const record = pendingRecord || createPendingCaptureRecord(downloadItem);
  activeAutomaticCaptures.add(record.id);
  try {
  if (!pendingRecord) {
    await savePendingCapture(record);
  }

  await settingsLoaded;

  if (!cachedSettings.extensionToken || !captureEnabledForURL(record.referrer || record.url)) {
    if (filenameWait) {
      filenameWait.cancel();
    }
    await removePendingCapture(record.id);
    await runDownloadAction("resume", record.id);
    return;
  }

  const filename = filenameWait
    ? await filenameWait.promise
    : record.filename;
  record.filename = filename || record.filename;
  await updatePendingCapture(record.id, {
    filename: record.filename,
    phase: "ready"
  });
  await updatePendingCapture(record.id, { phase: "sending" });

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
    await removePendingCapture(record.id);
    await runDownloadAction("resume", record.id);
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
    title: "Firelink Download Capture",
    message: "Download automatically forwarded to Firelink."
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

      const paused = await runDownloadAction("pause", record.id);
      if (!paused) {
        await removePendingCapture(record.id);
        continue;
      }
      await handleAutomaticCapture(
        {
          ...downloadItem,
          url: record.url,
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
      notify("Firelink Media Fetch", "Open a normal web page, then try Fetch media again.");
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
    notify("Firelink Media Fetch", "Media page sent to Firelink.");
  }

  return accepted;
}

function sendSelectionTextLinks(info, tab) {
  const urls = extractURLsFromText(info.selectionText);
  if (urls.length === 0) {
    return false;
  }
  sendToFirelink(urls, tab?.url || "", {
    cookieStoreId: tab?.cookieStoreId,
    incognito: tab?.incognito === true
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
      sendToFirelink([info.linkUrl], tab?.url || "", {
        cookieStoreId: tab?.cookieStoreId,
        incognito: tab?.incognito === true
      });
    }
    return;
  }

  if (info.menuItemId === "fetch-media-with-firelink") {
    fetchMediaForTab(tab, {
      srcUrl: info.srcUrl,
      notifyOnSuccess: true
    });
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
            sendToFirelink(response.links, tab?.url || "", {
              cookieStoreId: tab?.cookieStoreId,
              incognito: tab?.incognito === true
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
