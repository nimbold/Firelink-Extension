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
const LEGACY_MEDIA_FETCH_PROTOCOL_VERSION = 4;
const MEDIA_FETCH_PROTOCOL_VERSION = 7;
const LAUNCH_TIMEOUT_MS = 15000;
const LAUNCH_RETRY_MS = 500;
const LAUNCH_TIMEOUTS_BEFORE_COOLDOWN = 2;
const LAUNCH_COOLDOWN_MS = 60000;
const CAPTURE_FILENAME_SETTLE_TIMEOUT_MS = 2500;
const CAPTURE_PAUSE_SETTLE_TIMEOUT_MS = 2500;
const CAPTURE_PAUSE_SETTLE_INTERVAL_MS = 50;
const TORRENT_CAPTURE_PROTOCOL_VERSION = 5;
const TORRENT_BINARY_CAPTURE_PROTOCOL_VERSION = 6;
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_TORRENT_BYTES = Math.ceil(MAX_TORRENT_BYTES / 3) * 4;
const WEAK_CAPTURE_FILENAMES = new Set(["identifier", "download", "view", "uc"]);
const TORRENT_MIME_TYPES = new Set([
  "application/bittorrent",
  "application/x-bittorrent",
  "application/x-torrent"
]);
const MAX_HANDOFF_URLS = 200;
const SELECTION_LINK_MESSAGE_ACTION = "extractSelectionLinksV2";
const MEDIA_SNAPSHOT_MESSAGE_ACTION = "collectMediaSnapshotV1";
const MEDIA_DOCUMENT_IDENTITY_PORT = "firelink-media-document-v1";
const MEDIA_DOCUMENT_IDENTITY_MESSAGE = "document-identity";
const MEDIA_DOCUMENT_IDENTITY_ACK = "document-identity-ack";
const MEDIA_DISCOVERY_KEEPALIVE_PORT = "firelink-media-discovery-v1";
const MEDIA_DISCOVERY_SESSION_MS = 8000;
const MEDIA_HANDOFF_ID_MAX_LENGTH = 128;
const MEDIA_PHASE_INITIAL = "initial";
const MEDIA_PHASE_DISCOVERED = "discovered";
const MEDIA_DISCOVERY_MAX_CANDIDATES = 64;
const MEDIA_DISCOVERY_MAX_DOCUMENTS = 64;
const MEDIA_DISCOVERY_MAX_HEADERS = 4;
const MEDIA_DISCOVERY_MAX_HEADER_VALUE_LENGTH = 2048;
const MEDIA_DISCOVERY_MANIFEST_KIND_RANK = Object.freeze({
  m3u8: 0,
  mpd: 1,
  "ism/manifest": 2,
  ism: 3
});
const MEDIA_DISCOVERY_SAFE_HEADER_NAMES = Object.freeze({
  accept: "Accept",
  "accept-language": "Accept-Language",
  origin: "Origin",
  "user-agent": "User-Agent"
});
const PENDING_CAPTURE_STORAGE_KEY = "pendingAutomaticCaptures";
const PENDING_CAPTURE_RECOVERY_ALARM = "firelink-pending-capture-recovery";
const PENDING_CAPTURE_RECOVERY_DELAY_MS = 30_000;
let launchSession = null;
let launchCleanup = Promise.resolve();
const pendingDownloadFilenameWaits = new Map();
let pendingCaptureMutation = Promise.resolve();
let pendingCaptureRecovery = null;
const activeAutomaticCaptures = new Map();
const activeMediaDiscoverySessions = new Map();
const activeMediaFetchHandoffs = new Map();
const mediaDiscoveryObserverRegistrations = new Map();
const pendingMediaDocumentIdentityRequests = new Map();
let mediaDiscoverySequence = 0;
let mediaDiscoveryNonceSequence = 0;
let mediaHandoffSequence = 0;
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
    if (!PAGE_MEDIA_SCHEMES.has(url.protocol) || url.username || url.password) {
      return null;
    }
    // Fragments are local to the document and are not sent with HTTP
    // requests. Do not carry them into a media handoff or referer context.
    url.hash = "";
    return url.href;
  } catch (error) {
    return null;
  }
}

function mediaManifestKind(rawURL) {
  const normalizedURL = normalizePageMediaURL(rawURL);
  if (!normalizedURL) {
    return null;
  }

  try {
    const url = new URL(normalizedURL);
    if (url.username || url.password) {
      return null;
    }
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith(".m3u8")) return "m3u8";
    if (pathname.endsWith(".mpd")) return "mpd";
    if (pathname.endsWith(".ism/manifest")) return "ism/manifest";
    if (pathname.endsWith(".ism")) return "ism";
    return null;
  } catch (error) {
    return null;
  }
}

function normalizeMediaManifestURL(rawURL) {
  const normalizedURL = normalizePageMediaURL(rawURL);
  if (!normalizedURL || !mediaManifestKind(normalizedURL)) {
    return null;
  }

  try {
    const url = new URL(normalizedURL);
    return url.href;
  } catch (error) {
    return null;
  }
}

function rawMediaHeaderEntries(rawHeaders) {
  if (Array.isArray(rawHeaders)) {
    return rawHeaders;
  }
  if (!rawHeaders || typeof rawHeaders !== "object") {
    return [];
  }
  return Object.entries(rawHeaders).map(([name, value]) => ({ name, value }));
}

function validMediaHeaderValue(value) {
  return typeof value === "string"
    && value.length <= MEDIA_DISCOVERY_MAX_HEADER_VALUE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeSafeMediaHeaders(rawHeaders) {
  const normalized = new Map();
  for (const header of rawMediaHeaderEntries(rawHeaders)) {
    const rawName = typeof header?.name === "string" ? header.name.trim().toLowerCase() : "";
    const canonicalName = Object.prototype.hasOwnProperty.call(
      MEDIA_DISCOVERY_SAFE_HEADER_NAMES,
      rawName
    )
      ? MEDIA_DISCOVERY_SAFE_HEADER_NAMES[rawName]
      : undefined;
    if (!canonicalName || normalized.has(canonicalName)) {
      continue;
    }
    if (!validMediaHeaderValue(header.value)) {
      continue;
    }
    const value = header.value.trim();
    if (!value) {
      continue;
    }
    normalized.set(canonicalName, value);
    if (normalized.size >= MEDIA_DISCOVERY_MAX_HEADERS) {
      break;
    }
  }

  return Object.values(MEDIA_DISCOVERY_SAFE_HEADER_NAMES)
    .filter(name => normalized.has(name))
    .map(name => ({ name, value: normalized.get(name) }));
}

function mediaHeadersPayload(rawHeaders) {
  const headers = normalizeSafeMediaHeaders(rawHeaders);
  return headers.length > 0
    ? headers.map(({ name, value }) => `${name}: ${value}`).join("\n")
    : undefined;
}

function legacyMediaPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const {
    media_handoff_id: _mediaHandoffId,
    media_phase: _mediaPhase,
    media_protocol_version: _mediaProtocolVersion,
    ...legacyPayload
  } = payload;
  return legacyPayload;
}

function normalizeObservedMediaReferer(rawReferer, fallback = "") {
  const normalize = value => {
    const normalizedURL = normalizePageMediaURL(value);
    if (!normalizedURL) {
      return null;
    }
    try {
      const url = new URL(normalizedURL);
      if (url.username || url.password) {
        return null;
      }
      // Fragments are local to the document, but a page query can be part of
      // the media server's signed/session referer contract. Keep the validated
      // query in the dedicated referer field; it is never copied to headers.
      url.hash = "";
      return url.href;
    } catch (error) {
      return null;
    }
  };

  return normalize(rawReferer) || normalize(fallback) || "";
}

function rawMediaHeaderValue(rawHeaders, wantedName) {
  const normalizedName = wantedName.toLowerCase();
  for (const header of rawMediaHeaderEntries(rawHeaders)) {
    if (typeof header?.name !== "string"
      || header.name.trim().toLowerCase() !== normalizedName
      || !validMediaHeaderValue(header.value)) {
      continue;
    }
    return header.value.trim();
  }
  return "";
}

function mediaDiscoveryFrameId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mediaDiscoveryTabId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mediaDiscoveryWindowId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mediaDiscoveryDocumentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function mediaDiscoveryNonce(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function nextMediaDiscoveryNonce() {
  mediaDiscoveryNonceSequence += 1;
  return `${Date.now().toString(36)}-${mediaDiscoveryNonceSequence.toString(36)}`;
}

function normalizeMediaHandoffId(value) {
  return typeof value === "string"
    && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    && value.length <= MEDIA_HANDOFF_ID_MAX_LENGTH
    ? value
    : null;
}

function nextMediaHandoffId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return `m-${Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  // Browser runtimes provide crypto.getRandomValues. This bounded fallback is
  // only for restricted test/host environments where crypto is unavailable.
  mediaHandoffSequence += 1;
  return `m-${Date.now().toString(36)}-${mediaHandoffSequence.toString(36)}`;
}

function bindMediaDiscoveryDocument(session, documentId, frameId, windowId) {
  if (!session || session.closed || !documentId || frameId !== 0) {
    return false;
  }
  if (session.windowId !== null && windowId !== null && session.windowId !== windowId) {
    return false;
  }
  if (session.documentId && session.documentId !== documentId) {
    cancelMediaDiscoverySession(session);
    return false;
  }

  session.documentId = documentId;
  session.documentIds.add(documentId);
  session.contentDocumentBound = true;
  const pendingSnapshotURLs = session.pendingSnapshotURLs.splice(0);
  for (const url of pendingSnapshotURLs) {
    mergeMediaDiscoveryCandidate(session, createMediaDiscoveryCandidate(url, {
      frameId: 0,
      fallbackReferer: session.fallbackReferer,
      observedAt: session.startedAt
    }));
  }
  return true;
}

function settleMediaDocumentIdentityRequest(nonce, documentId) {
  const pending = pendingMediaDocumentIdentityRequests.get(nonce);
  if (!pending) {
    return false;
  }
  pendingMediaDocumentIdentityRequests.delete(nonce);
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  pending.resolve(documentId);
  return true;
}

function handleMediaDocumentIdentityPort(port) {
  if (port?.name !== MEDIA_DOCUMENT_IDENTITY_PORT) {
    return;
  }

  const sender = port.sender;
  const tabId = mediaDiscoveryTabId(sender?.tab?.id);
  const frameId = mediaDiscoveryFrameId(sender?.frameId);
  const windowId = mediaDiscoveryWindowId(sender?.tab?.windowId);
  const documentId = mediaDiscoveryDocumentId(sender?.documentId);
  const onMessage = message => {
    const nonce = mediaDiscoveryNonce(message?.nonce);
    if (message?.type !== MEDIA_DOCUMENT_IDENTITY_MESSAGE || !nonce) {
      return;
    }

    const session = tabId === null ? null : activeMediaDiscoverySessions.get(tabId);
    if (session?.identityNonce === nonce) {
      bindMediaDiscoveryDocument(session, documentId, frameId, windowId);
    }

    const pending = pendingMediaDocumentIdentityRequests.get(nonce);
    if (pending && pending.tabId === tabId && frameId === 0 && windowIdMatches(pending.windowId, windowId)) {
      settleMediaDocumentIdentityRequest(nonce, documentId && frameId === 0 ? documentId : null);
    }

    try {
      port.postMessage?.({ type: MEDIA_DOCUMENT_IDENTITY_ACK });
    } catch (error) {
      // The content side may have gone away after sending its identity.
    }
    try {
      port.disconnect?.();
    } catch (error) {
      // The browser may already have closed the one-shot identity port.
    }
  };

  port.onMessage?.addListener(onMessage);
}

function windowIdMatches(expected, actual) {
  return expected === null || actual === null || expected === actual;
}

if (chrome.runtime?.onConnect?.addListener) {
  chrome.runtime.onConnect.addListener(handleMediaDocumentIdentityPort);
}

function createMediaDiscoveryCandidate(rawURL, options = {}) {
  const url = normalizeMediaManifestURL(rawURL);
  if (!url) {
    return null;
  }

  const frameId = mediaDiscoveryFrameId(options.frameId);
  const observedAt = Number.isFinite(options.observedAt) ? options.observedAt : Date.now();
  const fallbackReferer = normalizeObservedMediaReferer(options.fallbackReferer);
  const observedReferer = normalizeObservedMediaReferer(options.referer);
  return {
    url,
    kind: mediaManifestKind(url),
    topFrame: frameId === 0,
    observedAt,
    sequence: ++mediaDiscoverySequence,
    headers: normalizeSafeMediaHeaders(options.headers),
    referer: observedReferer || fallbackReferer,
    hasObservedReferer: Boolean(observedReferer)
  };
}

function compareMediaDiscoveryCandidates(left, right) {
  const leftFrameRank = left.topFrame ? 0 : 1;
  const rightFrameRank = right.topFrame ? 0 : 1;
  if (leftFrameRank !== rightFrameRank) {
    return leftFrameRank - rightFrameRank;
  }

  const leftKindRank = MEDIA_DISCOVERY_MANIFEST_KIND_RANK[left.kind] ?? Number.MAX_SAFE_INTEGER;
  const rightKindRank = MEDIA_DISCOVERY_MANIFEST_KIND_RANK[right.kind] ?? Number.MAX_SAFE_INTEGER;
  if (leftKindRank !== rightKindRank) {
    return leftKindRank - rightKindRank;
  }

  if (left.observedAt !== right.observedAt) {
    return right.observedAt - left.observedAt;
  }
  return right.sequence - left.sequence;
}

function mergeMediaDiscoveryCandidate(session, candidate) {
  if (!session || session.closed || !candidate) {
    return;
  }

  const previous = session.candidates.get(candidate.url);
  const merged = previous
    ? (() => {
      // Keep request context attached to the observation that wins the frame
      // ranking. A URL can be requested by both a player iframe and the top
      // document; OR-ing topFrame while copying the latest child headers can
      // otherwise mix identities.
      const candidateContextWins = candidate.topFrame !== previous.topFrame
        ? candidate.topFrame
        : candidate.observedAt > previous.observedAt
          || (candidate.observedAt === previous.observedAt && candidate.sequence > previous.sequence);
      return {
        ...previous,
        ...candidate,
        topFrame: previous.topFrame || candidate.topFrame,
        observedAt: Math.max(previous.observedAt, candidate.observedAt),
        headers: candidateContextWins ? candidate.headers : previous.headers,
        referer: candidateContextWins ? candidate.referer : previous.referer,
        hasObservedReferer: candidateContextWins
          ? candidate.hasObservedReferer
          : previous.hasObservedReferer
      };
    })()
    : candidate;
  session.candidates.set(candidate.url, merged);

  if (session.candidates.size <= MEDIA_DISCOVERY_MAX_CANDIDATES) {
    return;
  }

  const worst = Array.from(session.candidates.values())
    .sort(compareMediaDiscoveryCandidates)
    .at(-1);
  if (worst) {
    session.candidates.delete(worst.url);
  }
}

function completeMediaDiscoverySession(session) {
  if (!session || session.completionSettled) {
    return;
  }
  session.completionSettled = true;
  releaseMediaDiscoveryKeepAlive(session.keepAlivePort);
  session.keepAlivePort = null;
  session.completeResolve?.();
}

async function sendMediaDiscoveryUpdate(session, candidate) {
  if (!session
    || session.invalidated
    || session.updateStarted
    || !session.initialAccepted
    || session.twoPhaseMediaSupported === false
    || !session.contentDocumentBound
    || !mediaDiscoveryDocumentId(session.documentId)
    || !candidate
    || candidate.url === session.fallbackURL
    || !normalizeMediaHandoffId(session.handoffId)) {
    return false;
  }

  session.updateStarted = true;
  let handoffTab;
  try {
    handoffTab = await revalidateMediaFetchTab(session.tab, session.documentId);
  } catch (error) {
    handoffTab = null;
  }
  if (!handoffTab || session.invalidated) {
    return false;
  }

  let retryableFailure = false;
  const sendUpdate = () => sendToFirelink([candidate.url], candidate.referer, {
    // The initial page handoff already owns process launch. A late
    // discovery update must never launch a second desktop instance after
    // that handoff has expired or been invalidated.
    allowProtocolFallback: false,
    cookieStoreId: handoffTab.cookieStoreId,
    incognito: handoffTab.incognito === true,
    forwardCookies: false,
    includeUserAgent: false,
    mediaHeaders: candidate.headers,
    media: true,
    mediaHandoffId: session.handoffId,
    mediaPhase: MEDIA_PHASE_DISCOVERED,
    notifyOnFailure: false,
    onHandoffError: error => {
      retryableFailure = error?.serverReached === true && error?.status === 504;
    }
  });

  try {
    const accepted = await sendUpdate();
    if (accepted || !retryableFailure || session.invalidated) {
      return accepted;
    }
    // The native server marks an unacknowledged delivery retryable before
    // returning 504. Its admission state makes this one replay safe: it is
    // either a fresh attempt or a duplicate of an attempt that did finish.
    retryableFailure = false;
    return await sendUpdate();
  } catch (error) {
    // Any non-timeout failure remains intentionally single-shot. The native
    // admission fence prevents an ambiguous response from being replayed.
    return false;
  }
}

function maybeCompleteMediaDiscoverySession(session) {
  if (!session
    || !session.closed
    || !session.initialSettled
    || session.completionStarted) {
    return;
  }

  session.completionStarted = true;
  const updatePromise = session.initialAccepted
    && session.selectedCandidate
    && !session.invalidated
    ? sendMediaDiscoveryUpdate(session, session.selectedCandidate)
    : Promise.resolve(false);
  void updatePromise.finally(() => completeMediaDiscoverySession(session));
}

function finishMediaDiscoverySession(session) {
  if (!session || session.closed) {
    return;
  }
  session.closed = true;
  if (session.timer !== null) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (activeMediaDiscoverySessions.get(session.tabId) === session) {
    activeMediaDiscoverySessions.delete(session.tabId);
  }
  uninstallMediaDiscoveryObserver(session.tabId);

  const candidate = Array.from(session.candidates.values())
    .sort(compareMediaDiscoveryCandidates)[0];
  session.selectedCandidate = candidate || null;
  session.resolve(candidate
    ? {
      url: candidate.url,
      referer: candidate.referer || session.fallbackReferer,
      headers: [...candidate.headers],
      documentId: session.documentId,
      invalidated: session.invalidated === true
    }
    : {
      url: session.fallbackURL,
      referer: session.fallbackReferer || session.fallbackURL,
      headers: [],
      documentId: session.documentId,
      invalidated: session.invalidated === true
    });
  maybeCompleteMediaDiscoverySession(session);
}

function settleMediaDiscoveryInitialHandoff(session, accepted, ambiguous = false) {
  if (!session || session.initialSettled) {
    return;
  }
  session.initialSettled = true;
  session.initialAccepted = accepted === true;
  session.initialHandoffResolve?.({
    accepted: session.initialAccepted,
    ambiguous: ambiguous === true
  });
  session.initialHandoffResolve = null;
  maybeCompleteMediaDiscoverySession(session);
}

function cancelMediaDiscoverySession(session) {
  if (!session || session.closed) {
    return;
  }
  // A navigation invalidates every request observed for the old document. Do
  // not let a pre-navigation candidate cross the page/referrer boundary.
  session.invalidated = true;
  session.candidates.clear();
  session.pendingSnapshotURLs.length = 0;
  finishMediaDiscoverySession(session);
}

function cancelMediaDiscoveryForTab(tabId) {
  const normalizedTabId = mediaDiscoveryTabId(tabId);
  if (normalizedTabId === null) {
    return;
  }
  cancelMediaDiscoverySession(activeMediaDiscoverySessions.get(normalizedTabId));
}

function observeMediaRequest(details) {
  const tabId = mediaDiscoveryTabId(details?.tabId);
  if (tabId === null) {
    return;
  }
  const session = activeMediaDiscoverySessions.get(tabId);
  if (!session || session.closed) {
    return;
  }
  const requestWindowId = mediaDiscoveryWindowId(details?.windowId);
  if (session.windowId !== null
    && requestWindowId !== null
    && session.windowId !== requestWindowId) {
    return;
  }
  if (Date.now() >= session.expiresAt) {
    finishMediaDiscoverySession(session);
    return;
  }

  const frameId = mediaDiscoveryFrameId(details?.frameId);
  const documentId = mediaDiscoveryDocumentId(details?.documentId);
  if (!documentId) {
    // Without a document identity, a request from a same-URL replacement
    // document cannot be distinguished from the initiating page.
    return;
  }
  if (frameId === 0) {
    if (session.documentId && session.documentId !== documentId) {
      cancelMediaDiscoverySession(session);
      return;
    }
    session.documentId ||= documentId;
    session.contentDocumentBound = true;
    session.documentIds.add(documentId);
  } else {
    if (frameId === null || !session.documentId || !session.documentIds.has(session.documentId)) {
      return;
    }
    const parentDocumentId = mediaDiscoveryDocumentId(details?.parentDocumentId);
    if (!parentDocumentId || !session.documentIds.has(parentDocumentId)) {
      return;
    }
    if (!session.documentIds.has(documentId)) {
      if (session.documentIds.size >= MEDIA_DISCOVERY_MAX_DOCUMENTS) {
        return;
      }
      session.documentIds.add(documentId);
    }
  }

  mergeMediaDiscoveryCandidate(session, createMediaDiscoveryCandidate(details.url, {
    frameId,
    headers: details.requestHeaders,
    referer: rawMediaHeaderValue(details.requestHeaders, "referer"),
    fallbackReferer: session.fallbackReferer,
    observedAt: Date.now()
  }));
}

function normalizeMediaSnapshotURLs(value) {
  const rawURLs = Array.isArray(value) ? value : value?.urls;
  if (!Array.isArray(rawURLs)) {
    return [];
  }

  const urls = [];
  const seen = new Set();
  for (const rawURL of rawURLs) {
    const url = normalizeMediaManifestURL(rawURL);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
    if (urls.length >= MEDIA_DISCOVERY_MAX_CANDIDATES) {
      break;
    }
  }
  return urls;
}

function normalizeMediaSnapshot(value) {
  return {
    urls: normalizeMediaSnapshotURLs(value)
  };
}

async function requestMediaSnapshot(tabId, nonce) {
  if (mediaDiscoveryTabId(tabId) === null || !chrome.tabs?.sendMessage) {
    return { urls: [] };
  }

  const result = await callExtensionApi(chrome.tabs, "sendMessage", [
    tabId,
    { action: MEDIA_SNAPSHOT_MESSAGE_ACTION, nonce },
    { frameId: 0 }
  ]);
  return result.ok ? normalizeMediaSnapshot(result.value) : { urls: [] };
}

function requestMediaDocumentIdentity(tabId, windowId = null) {
  if (mediaDiscoveryTabId(tabId) === null || !chrome.tabs?.sendMessage) {
    return Promise.resolve(null);
  }

  const nonce = nextMediaDiscoveryNonce();
  const promise = new Promise(resolve => {
    const timer = setTimeout(() => {
      settleMediaDocumentIdentityRequest(nonce, null);
    }, 1000);
    pendingMediaDocumentIdentityRequests.set(nonce, {
      tabId,
      windowId: mediaDiscoveryWindowId(windowId),
      timer,
      resolve
    });
  });

  void callExtensionApi(chrome.tabs, "sendMessage", [
    tabId,
    { action: MEDIA_SNAPSHOT_MESSAGE_ACTION, nonce },
    { frameId: 0 }
  ]).then(result => {
    if (!result.ok) {
      settleMediaDocumentIdentityRequest(nonce, null);
    }
  });
  return promise;
}

function startMediaDiscoverySession(options = {}) {
  const tabId = mediaDiscoveryTabId(options.tabId);
  const fallbackURL = normalizePageMediaURL(options.fallbackURL);
  if (tabId === null || !fallbackURL) {
    const fallbackTarget = {
      url: fallbackURL,
      referer: normalizeObservedMediaReferer(options.fallbackReferer, fallbackURL),
      headers: []
    };
    return {
      tabId,
      windowId: mediaDiscoveryWindowId(options.windowId),
      tab: options.tab || null,
      handoffId: normalizeMediaHandoffId(options.handoffId),
      fallbackURL,
      fallbackReferer: fallbackTarget.referer || fallbackURL || "",
      startedAt: Date.now(),
      expiresAt: Date.now(),
      identityNonce: null,
      documentId: null,
      contentDocumentBound: false,
      documentIds: new Set(),
      pendingSnapshotURLs: [],
      candidates: new Map(),
      closed: true,
      invalidated: false,
      timer: null,
      resolve: null,
      promise: Promise.resolve(fallbackTarget),
      completeResolve: null,
      donePromise: Promise.resolve(),
      initialSettled: true,
      initialAccepted: false,
      selectedCandidate: null,
      updateStarted: false,
      completionStarted: true,
      completionSettled: true,
      twoPhaseMediaSupported: false,
      initialHandoffStarted: true,
      initialHandoffPromise: Promise.resolve({ accepted: false, ambiguous: false }),
      initialHandoffResolve: null,
      keepAlivePort: null
    };
  }

  const existing = activeMediaDiscoverySessions.get(tabId);
  if (existing && !existing.closed) {
    const requestedWindowId = mediaDiscoveryWindowId(options.windowId);
    if (existing.windowId === requestedWindowId && existing.fallbackURL === fallbackURL) {
      return existing;
    }
    // A delayed tabs.onUpdated notification must not let a new Fetch media
    // action reuse a session belonging to a different page in the same tab.
    cancelMediaDiscoverySession(existing);
  }

  const canonicalURL = normalizeObservedMediaReferer(options.canonicalURL, fallbackURL);
  const startedAt = Date.now();
  const session = {
    tabId,
    windowId: mediaDiscoveryWindowId(options.windowId),
    tab: options.tab || { id: tabId, windowId: options.windowId, url: fallbackURL },
    handoffId: normalizeMediaHandoffId(options.handoffId),
    fallbackURL,
    fallbackReferer: canonicalURL || fallbackURL,
    startedAt,
    expiresAt: startedAt + MEDIA_DISCOVERY_SESSION_MS,
    identityNonce: nextMediaDiscoveryNonce(),
    documentId: null,
    contentDocumentBound: false,
    documentIds: new Set(),
    pendingSnapshotURLs: [],
    candidates: new Map(),
    closed: false,
    invalidated: false,
    timer: null,
    resolve: null,
    promise: null,
    completeResolve: null,
    donePromise: null,
    initialSettled: false,
    initialAccepted: false,
    selectedCandidate: null,
    updateStarted: false,
    completionStarted: false,
    completionSettled: false,
    twoPhaseMediaSupported: true,
    initialHandoffStarted: false,
    initialHandoffPromise: null,
    initialHandoffResolve: null,
    keepAlivePort: options.keepAlivePort || null
  };
  session.promise = new Promise(resolve => {
    session.resolve = resolve;
  });
  session.donePromise = new Promise(resolve => {
    session.completeResolve = resolve;
  });
  session.initialHandoffPromise = new Promise(resolve => {
    session.initialHandoffResolve = resolve;
  });
  activeMediaDiscoverySessions.set(tabId, session);
  installMediaDiscoveryObserver(session);
  session.timer = setTimeout(() => finishMediaDiscoverySession(session), MEDIA_DISCOVERY_SESSION_MS);

  void requestMediaSnapshot(tabId, session.identityNonce).then(snapshot => {
    if (session.closed) {
      return;
    }
    // Hold the content snapshot until the content-originated identity port
    // binds the initiating top-frame document. A same-URL reload can
    // otherwise contribute a manifest from the wrong document. Browsers that
    // cannot provide that identity use the canonical page fallback.
    session.pendingSnapshotURLs = snapshot.urls;
    if (!session.contentDocumentBound) return;
    for (const url of session.pendingSnapshotURLs.splice(0)) {
      mergeMediaDiscoveryCandidate(session, createMediaDiscoveryCandidate(url, {
        frameId: 0,
        fallbackReferer: session.fallbackReferer,
        observedAt: session.startedAt
      }));
    }
  }).catch(() => {
    // A restricted page or an unavailable content script only removes the
    // snapshot source. The bounded webRequest session and page fallback remain
    // usable without retrying or injecting code.
  });

  return session;
}

function installMediaDiscoveryObserver(session) {
  const tabId = mediaDiscoveryTabId(session?.tabId);
  if (tabId === null || mediaDiscoveryObserverRegistrations.has(tabId)) {
    return;
  }

  const event = chrome.webRequest?.onBeforeSendHeaders;
  if (!event?.addListener) {
    return;
  }

  const filter = { urls: ["http://*/*", "https://*/*"], tabId };
  const listener = details => observeMediaRequest(details);
  try {
    // Request-header observation is non-blocking and is registered only while
    // a user-triggered discovery session is active. Do not request
    // blocking. Chromium requires extraHeaders for some safe context headers;
    // any credential-bearing headers exposed by that flag are discarded by
    // observeMediaRequest and are never persisted or forwarded.
    event.addListener(listener, filter, ["requestHeaders", "extraHeaders"]);
    mediaDiscoveryObserverRegistrations.set(tabId, { event, listener });
  } catch (error) {
    // Firefox versions that do not accept extraHeaders still support the
    // non-blocking requestHeaders signal. Retry with the portable subset; if
    // that also fails, the Fetch media action falls back to the page URL.
    try {
      event.addListener(listener, filter, ["requestHeaders"]);
      mediaDiscoveryObserverRegistrations.set(tabId, { event, listener });
    } catch (fallbackError) {
      // The Fetch media action will fall back to the canonical page URL.
    }
  }
}

function uninstallMediaDiscoveryObserver(tabId) {
  const normalizedTabId = mediaDiscoveryTabId(tabId);
  const registrations = normalizedTabId === null
    ? Array.from(mediaDiscoveryObserverRegistrations.entries())
    : [[normalizedTabId, mediaDiscoveryObserverRegistrations.get(normalizedTabId)]];
  for (const [registrationTabId, registration] of registrations) {
    if (!registration) {
      continue;
    }
    mediaDiscoveryObserverRegistrations.delete(registrationTabId);
    try {
      registration.event.removeListener?.(registration.listener);
    } catch (error) {
      // The discovery state is still closed; a browser-specific listener
      // teardown failure must not keep request metadata in the session.
    }
  }
}

function cancelMediaDiscoveryOnActivation(activeInfo) {
  const activeTabId = mediaDiscoveryTabId(activeInfo?.tabId);
  if (activeTabId === null) {
    return;
  }
  for (const session of activeMediaDiscoverySessions.values()) {
    // Tab ids are browser-global. Keeping only the newly active tab also
    // handles focus moving to another window; a session from that window is
    // no longer an active-tab discovery session and must not observe requests.
    if (session.tabId === activeTabId) {
      continue;
    }
    cancelMediaDiscoverySession(session);
  }
}

if (chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.status === "loading" || typeof changeInfo?.url === "string") {
      cancelMediaDiscoveryForTab(tabId);
    }
  });
}

if (chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener(tabId => cancelMediaDiscoveryForTab(tabId));
}

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(cancelMediaDiscoveryOnActivation);
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

function reportSelectedLinkCapture(stage, frameId, source, count, reason) {
  if (typeof console === "undefined" || typeof console.debug !== "function") {
    return;
  }
  console.debug("Firelink selected-link capture", {
    stage,
    frameId: Number.isSafeInteger(frameId) && frameId >= 0 ? frameId : null,
    source: typeof source === "string" ? source : "none",
    count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
    reason: typeof reason === "string" ? reason : "unknown"
  });
}

function notifyNoSelectedLinks() {
  notify(
    backgroundText("notifications", "noLinksTitle", "No downloadable links found"),
    backgroundText(
      "notifications",
      "noLinksMessage",
      "The selection contains no downloadable links. Select links with actual download URLs and try again."
    )
  );
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
    awaitingPauseConfirmation: false,
    pauseConfirmed: false,
    pauseUnconfirmed: false,
    terminal: false,
    terminalState: undefined,
    observedDownloadFields: {},
    completedTorrent: false,
    downloadMissing: false,
    downloadLookupFailed: false,
    handoffStarted: false,
    handoffMayHaveBeenSent: false,
    cleanupStarted: false,
    cleanupTerminalExpected: false,
    pendingChangeReconciliation: Promise.resolve()
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
  // A terminal event caused by our own cancel/erase is expected during the
  // cleanup window. A resume is always user intent and must be observed even
  // while cleanup is in flight.
  const expectedCancellation = session.cleanupTerminalExpected
    && terminalState === "interrupted";
  if (resumed && !expectedCancellation) {
    session.userResumed = true;
  }
  if (terminal && !expectedCancellation) {
    markAutomaticCaptureTerminal(session, terminalState);
  }
  return true;
}

function markAutomaticCaptureTerminal(session, terminalState) {
  session.terminal = true;
  // Completion is monotonic. A late interruption delta must not downgrade
  // a completed item and block the non-destructive torrent handoff.
  if (session.terminalState !== "complete" || terminalState === "complete") {
    session.terminalState = terminalState;
  }
}

function markAutomaticCaptureCompletedTorrent(session) {
  session.terminal = true;
  session.terminalState = "complete";
  session.completedTorrent = true;
  session.awaitingPauseConfirmation = false;
  session.pauseConfirmed = true;
}

function automaticCaptureInvalidated(session, { allowCompletedTorrent = false } = {}) {
  const terminalCompleted = session.terminalState === "complete";
  return session.userResumed
    || session.downloadMissing
    || (session.terminal
      && !(session.completedTorrent || (allowCompletedTorrent && terminalCompleted)));
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
  if (downloadItem?.state === "complete") {
    return true;
  }

  // Firefox reports a paused download as `state: "interrupted"` with
  // `paused: true` (and may expose USER_CANCELED as its interruption reason).
  // The paused flag is the authoritative lifecycle signal here: treating all
  // interrupted items as terminal prevents the handoff and strands the
  // browser download in the paused state.
  return downloadItem?.state === "interrupted" && downloadItem.paused !== true;
}

function isTerminalDownloadChange(change) {
  const state = change?.state?.current;
  if (state === "complete") {
    return true;
  }

  // A state-only Firefox interruption event is ambiguous until the current
  // download snapshot is inspected. Do not invalidate an active capture
  // unless the event explicitly says that the item is not paused.
  return state === "interrupted" && change.paused?.current === false;
}

async function reconcileActiveAutomaticCaptureState(downloadId, session) {
  if (activeAutomaticCaptures.get(downloadId) !== session) {
    return;
  }

  let downloadItem;
  try {
    downloadItem = await findDownload(downloadId);
  } catch (error) {
    return;
  }
  if (activeAutomaticCaptures.get(downloadId) !== session) {
    return;
  }
  if (!downloadItem) {
    // A missing item caused by our own cancel/erase is an expected cleanup
    // result. Outside cleanup it invalidates the active capture so no later
    // response can make an operation against a reused browser ID.
    if (!session.cleanupStarted) {
      session.downloadMissing = true;
    }
    return;
  }

  const terminal = isTerminalDownload(downloadItem);
  const resumed = downloadItem.paused === false && !terminal;
  if (resumed || terminal) {
    noteAutomaticCaptureChange(downloadId, {
      resumed,
      terminal,
      terminalState: downloadItem.state
    });
    settleDownloadFilenameWait(downloadId);
  }
}

function queueActiveAutomaticCaptureReconciliation(downloadId, session) {
  const operation = session.pendingChangeReconciliation
    .then(() => reconcileActiveAutomaticCaptureState(downloadId, session));
  session.pendingChangeReconciliation = operation.catch(() => {});
}

async function findOwnedAutomaticDownload(
  record,
  session,
  { waitForPause = false, allowCompletedTorrent = false } = {}
) {
  if (automaticCaptureInvalidated(session, { allowCompletedTorrent })) {
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
    if (allowCompletedTorrent
      && downloadItem.state === "complete"
      && isDefiniteTorrentDownload(record, downloadItem, session.observedDownloadFields)) {
      markAutomaticCaptureCompletedTorrent(session);
      return downloadItem;
    }
    markAutomaticCaptureTerminal(session, downloadItem.state);
    return null;
  }
  // The completion event is authoritative for this browser-owned download.
  // A search immediately after that event can briefly expose the previous
  // in-progress snapshot, especially for very small files. Keep the verified
  // torrent handoff alive without issuing a pause/cancel/erase action against
  // that stale snapshot.
  if (allowCompletedTorrent
    && session.terminalState === "complete"
    && isDefiniteTorrentDownload(record, downloadItem, session.observedDownloadFields)) {
    markAutomaticCaptureCompletedTorrent(session);
    return downloadItem;
  }
  if (session.terminal) {
    return null;
  }
  if (downloadItem.paused !== true) {
    if (waitForPause && session.awaitingPauseConfirmation && !session.pauseConfirmed) {
      const deadline = Date.now() + CAPTURE_PAUSE_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (automaticCaptureInvalidated(session, { allowCompletedTorrent })) {
          return null;
        }
        await delay(Math.min(
          CAPTURE_PAUSE_SETTLE_INTERVAL_MS,
          Math.max(0, deadline - Date.now())
        ));
        if (automaticCaptureInvalidated(session, { allowCompletedTorrent })) {
          return null;
        }
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
          if (allowCompletedTorrent
            && downloadItem.state === "complete"
            && isDefiniteTorrentDownload(record, downloadItem, session.observedDownloadFields)) {
            markAutomaticCaptureCompletedTorrent(session);
            return downloadItem;
          }
          markAutomaticCaptureTerminal(session, downloadItem.state);
          return null;
        }
        if (allowCompletedTorrent
          && session.terminalState === "complete"
          && isDefiniteTorrentDownload(record, downloadItem, session.observedDownloadFields)) {
          markAutomaticCaptureCompletedTorrent(session);
          return downloadItem;
        }
        if (session.terminal) {
          return null;
        }
        if (downloadItem.paused === true) {
          session.pauseConfirmed = true;
          session.awaitingPauseConfirmation = false;
          return downloadItem;
        }
      }
      session.pauseUnconfirmed = true;
      session.downloadLookupFailed = true;
      return null;
    }
    session.userResumed = true;
    return null;
  }
  session.pauseConfirmed = true;
  session.awaitingPauseConfirmation = false;
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
  let attemptedLegacyMediaFallback = false;
  let deliveryPath = entry.path || "/download";
  let deliveryPayload = entry.payload;
  let deliveryRequiredProtocolVersion = entry.requiredProtocolVersion;
  let usingLegacyMediaFallback = false;
  while (Date.now() < deadline) {
    try {
      await FirelinkProtocol.signedFetch(deliveryPath, entry.token, {
        method: "POST",
        payload: deliveryPayload,
        requiredProtocolVersion: deliveryRequiredProtocolVersion
      });
      if (usingLegacyMediaFallback) {
        try {
          entry.onLegacyMediaFallback?.(true);
        } catch (callbackError) {
          // A capability note must not turn a successful legacy handoff
          // into an apparent transport failure.
        }
      }
      return true;
    } catch (error) {
      const canUseLegacyMediaFallback = !attemptedLegacyMediaFallback
        && entry.legacyPayload
        && entry.legacyRequiredProtocolVersion
        && error?.serverReached === true
        && error?.status === 426
        && error?.code === "protocol-version"
        && !handoffMayHaveBeenSent(error);
      if (canUseLegacyMediaFallback) {
        attemptedLegacyMediaFallback = true;
        deliveryPath = entry.legacyPath || "/download";
        deliveryPayload = entry.legacyPayload;
        deliveryRequiredProtocolVersion = entry.legacyRequiredProtocolVersion;
        usingLegacyMediaFallback = true;
        continue;
      }
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
      path: options.path || "/download",
      legacyPath: options.legacyPath || "/download",
      legacyPayload: options.legacyPayload
        ? Object.freeze({ ...options.legacyPayload, urls: Object.freeze([...options.legacyPayload.urls]) })
        : null,
      legacyRequiredProtocolVersion: options.legacyRequiredProtocolVersion,
      onLegacyMediaFallback: options.onLegacyMediaFallback,
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

function isBrowserLocalTorrentURL(value) {
  try {
    return ["blob:", "data:"].includes(new URL(value).protocol);
  } catch (error) {
    return false;
  }
}

function isValidTorrentBytesPayload(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ENCODED_TORRENT_BYTES
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function isDefiniteTorrentDownload(record, downloadItem, observedFields = {}) {
  const observedRecord = { ...record, ...observedFields };
  return isTorrentDownload(downloadItem, downloadItem?.filename)
    || isTorrentDownload(downloadItem, observedRecord.filename)
    || isTorrentDownload(observedRecord, observedRecord.filename);
}

function isCompletedTorrentDownload(record, downloadItem, observedFields = {}) {
  return downloadItem?.state === "complete"
    && isDefiniteTorrentDownload(record, downloadItem, observedFields);
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
  const mediaHandoffId = options.media === true
    ? normalizeMediaHandoffId(options.mediaHandoffId)
    : null;
  const mediaPhase = options.media === true
    && (options.mediaPhase === MEDIA_PHASE_INITIAL
      || options.mediaPhase === MEDIA_PHASE_DISCOVERED)
    ? options.mediaPhase
    : null;
  const hasVersionedMediaHandoff = options.media === true
    && mediaHandoffId !== null
    && mediaPhase !== null;
  const isMediaDiscoveryUpdate = hasVersionedMediaHandoff
    && mediaPhase === MEDIA_PHASE_DISCOVERED;
  if (options.media === true
    && ((options.mediaHandoffId !== undefined && mediaHandoffId === null)
      || (options.mediaPhase !== undefined && mediaPhase === null)
      || (mediaHandoffId !== null && mediaPhase === null)
      || (mediaHandoffId === null && mediaPhase !== null))) {
    return false;
  }
  const hasTorrentBytes = options.torrentBytesBase64 !== undefined
    && options.torrentBytesBase64 !== null;
  if (hasTorrentBytes && !isValidTorrentBytesPayload(options.torrentBytesBase64)) {
    return false;
  }
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
    && !hasTorrentBytes
    && options.media !== true
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
    && (options.torrent === true || containsTorrentURL || hasTorrentBytes);
  if (hasTorrentBytes && (options.media === true || !isTorrent)) {
    return false;
  }
  const mediaHeaders = options.media === true
    ? mediaHeadersPayload(options.mediaHeaders)
    : undefined;
  let payload = isMediaDiscoveryUpdate
    ? {
      handoff_id: mediaHandoffId,
      phase: mediaPhase,
      media_protocol_version: MEDIA_FETCH_PROTOCOL_VERSION,
      urls: normalizedURLs,
      referer,
      headers: mediaHeaders
    }
    : {
      urls: normalizedURLs,
      referer,
      silent: captureMode === "automatic",
      filename: options.filename,
      headers: options.media === true
        ? mediaHeaders
        : options.includeUserAgent === false
        || typeof navigator === "undefined"
        || typeof navigator.userAgent !== "string"
        ? undefined
        : `User-Agent: ${navigator.userAgent}`,
      cookies: cookieString || undefined,
      cookie_scopes: cookieScopes.length > 0 ? cookieScopes : undefined,
      media: options.media === true,
      media_handoff_id: hasVersionedMediaHandoff ? mediaHandoffId : undefined,
      media_phase: hasVersionedMediaHandoff ? mediaPhase : undefined,
      media_protocol_version: hasVersionedMediaHandoff
        ? MEDIA_FETCH_PROTOCOL_VERSION
        : undefined,
      torrent_bytes_base64: hasTorrentBytes ? options.torrentBytesBase64 : undefined
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

  let requiredProtocolVersion = options.media === true
    ? hasVersionedMediaHandoff
      ? MEDIA_FETCH_PROTOCOL_VERSION
      : LEGACY_MEDIA_FETCH_PROTOCOL_VERSION
    : hasTorrentBytes
    ? TORRENT_BINARY_CAPTURE_PROTOCOL_VERSION
    : (isTorrent || containsTorrentURL || options.torrent === true)
    ? TORRENT_CAPTURE_PROTOCOL_VERSION
    : captureMode === "automatic" ? 3 : undefined;
  const handoffPath = isMediaDiscoveryUpdate ? "/media-discovery" : "/download";
  const legacyMediaFallbackAllowed = options.allowLegacyMediaFallback !== false
    && options.media === true
    && !isMediaDiscoveryUpdate
    && mediaPhase === MEDIA_PHASE_INITIAL
    && hasVersionedMediaHandoff;

  let attemptedLegacyMediaFallback = false;
  try {
    await FirelinkProtocol.signedFetch(
      handoffPath,
      cachedSettings.extensionToken,
      {
      method: "POST",
      payload,
      requiredProtocolVersion
      }
    );
    return true;
  } catch (error) {
    const canUseLegacyMediaFallback = !attemptedLegacyMediaFallback
      && legacyMediaFallbackAllowed
      && error?.serverReached === true
      && error?.status === 426
      && error?.code === "protocol-version"
      && !handoffMayHaveBeenSent(error);
    if (canUseLegacyMediaFallback) {
      attemptedLegacyMediaFallback = true;
      payload = legacyMediaPayload(payload);
      requiredProtocolVersion = LEGACY_MEDIA_FETCH_PROTOCOL_VERSION;
      try {
        await FirelinkProtocol.signedFetch(
          "/download",
          cachedSettings.extensionToken,
          {
            method: "POST",
            payload,
            requiredProtocolVersion
          }
        );
        try {
          options.onLegacyMediaFallback?.(true);
        } catch (callbackError) {
          // A caller-side capability note must never turn a successful
          // legacy handoff into an apparent transport failure.
        }
        return true;
      } catch (fallbackError) {
        error = fallbackError;
      }
    }

    try {
      options.onHandoffError?.(error);
    } catch (callbackError) {
      // Error observers must not alter the handoff result.
    }

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
          {
            token: cachedSettings.extensionToken,
            payload,
            requiredProtocolVersion,
            path: handoffPath
          },
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
        {
          ...options,
          path: handoffPath,
          legacyPath: legacyMediaFallbackAllowed ? "/download" : undefined,
          legacyPayload: legacyMediaFallbackAllowed ? legacyMediaPayload(payload) : undefined,
          legacyRequiredProtocolVersion: legacyMediaFallbackAllowed
            ? LEGACY_MEDIA_FETCH_PROTOCOL_VERSION
            : undefined
        }
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
      if (session.pauseUnconfirmed) {
        await resumeAndForgetAutomaticCapture(record.id, session);
        return;
      }
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

    let currentDownload = await findOwnedAutomaticDownload(record, session, {
      waitForPause: true,
      allowCompletedTorrent: true
    });
    if (!currentDownload) {
      await abandonBeforeHandoff();
      return;
    }
    const filename = filenameWait
      ? await filenameWait.promise
      : record.filename;
    record.filename = filename || record.filename;
    // Filename settling can yield while the user resumes the item or while
    // redirects and headers update the browser's download metadata. Recheck
    // ownership after the wait and use that fresh snapshot for the handoff.
    currentDownload = await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    });
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
    } else if (isUsableCaptureFilename(session.observedDownloadFields.filename)) {
      record.filename = session.observedDownloadFields.filename;
    }
    if ((!record.finalUrl || typeof record.finalUrl !== "string")
      && typeof session.observedDownloadFields.finalUrl === "string"
      && session.observedDownloadFields.finalUrl) {
      record.finalUrl = session.observedDownloadFields.finalUrl;
    }
    if ((!record.mime || typeof record.mime !== "string")
      && typeof session.observedDownloadFields.mime === "string"
      && session.observedDownloadFields.mime) {
      record.mime = session.observedDownloadFields.mime;
    }
    let torrent = isDefiniteTorrentDownload(
      record,
      currentDownload,
      session.observedDownloadFields
    );
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
    if (!automaticCaptureAllowedForDownload(record.url, record.referrer)) {
      await abandonBeforeHandoff();
      return;
    }

    const ownedBeforeSend = await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    });
    if (!ownedBeforeSend) {
      await abandonBeforeHandoff();
      return;
    }
    // A redirect, filename, or MIME event may have arrived while the phase
    // updates were being persisted. Recompute from the final owned snapshot
    // and every observed delta immediately before sending the request.
    if (typeof ownedBeforeSend.finalUrl === "string" && ownedBeforeSend.finalUrl) {
      record.finalUrl = ownedBeforeSend.finalUrl;
    }
    if (typeof ownedBeforeSend.mime === "string" && ownedBeforeSend.mime) {
      record.mime = ownedBeforeSend.mime;
    }
    const ownedFilename = normalizeCaptureFilename(ownedBeforeSend.filename);
    if (isUsableCaptureFilename(ownedFilename)) {
      record.filename = ownedFilename;
    } else if (isUsableCaptureFilename(session.observedDownloadFields.filename)) {
      record.filename = session.observedDownloadFields.filename;
    }
    if ((!record.finalUrl || typeof record.finalUrl !== "string")
      && typeof session.observedDownloadFields.finalUrl === "string"
      && session.observedDownloadFields.finalUrl) {
      record.finalUrl = session.observedDownloadFields.finalUrl;
    }
    if ((!record.mime || typeof record.mime !== "string")
      && typeof session.observedDownloadFields.mime === "string"
      && session.observedDownloadFields.mime) {
      record.mime = session.observedDownloadFields.mime;
    }
    torrent = isDefiniteTorrentDownload(
      record,
      ownedBeforeSend,
      session.observedDownloadFields
    );

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

    // Completion may race the signed request itself. Re-read the browser item
    // before applying the normal active-download invalidation rule so an
    // accepted torrent can take the non-destructive completed path.
    if (session.terminal
      && session.terminalState === "complete"
      && !session.completedTorrent) {
      await findOwnedAutomaticDownload(record, session, {
        allowCompletedTorrent: true
      });
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

    if (!await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    })) {
      await markAmbiguousCapture(record.id);
      return;
    }

    if (session.completedTorrent) {
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
      return;
    }

    let cleanupSucceeded = false;
    session.cleanupStarted = true;
    try {
      if (!automaticCaptureInvalidated(session)) {
        session.cleanupTerminalExpected = true;
        const cancelled = await runDownloadAction("cancel", record.id);
        // Firefox may report the cancellation as an interrupted item and may
        // deliver a paused=false delta without a state delta. Reconcile the
        // current browser snapshot before erase so that a genuine user resume
        // cannot be mistaken for our own cancellation.
        await session.pendingChangeReconciliation;
        await reconcileActiveAutomaticCaptureState(record.id, session);
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
              await session.pendingChangeReconciliation;
              await reconcileActiveAutomaticCaptureState(record.id, session);
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

        // A completed torrent may have won the race with the original pause.
        // It is safe to hand off only while the record is still pre-delivery;
        // accepted, sending, and uncertain records must never be retried.
        if (isTerminalDownload(downloadItem)) {
          const terminalFilenameWait = waitForDownloadFilename(downloadItem);
          if (!isCompletedTorrentDownload(record, downloadItem)) {
            const settledFilename = await terminalFilenameWait.promise;
            if (settledFilename) {
              record.filename = settledFilename;
            }
            let refreshedDownloadItem;
            try {
              refreshedDownloadItem = await findDownload(record.id);
            } catch (error) {
              terminalFilenameWait.cancel();
              schedulePendingCaptureRecovery();
              continue;
            }
            if (!refreshedDownloadItem) {
              terminalFilenameWait.cancel();
              const removed = await removePendingCapture(record.id);
              if (!removed) {
                schedulePendingCaptureRecovery();
              }
              continue;
            }
            if (!pendingCaptureMatchesDownload(record, refreshedDownloadItem)) {
              terminalFilenameWait.cancel();
              const removed = await removePendingCapture(record.id);
              if (!removed) {
                schedulePendingCaptureRecovery();
              }
              continue;
            }
            downloadItem = refreshedDownloadItem;
          }

          const recoveredTorrentDownload = isCompletedTorrentDownload(record, downloadItem);
          if (recoveredTorrentDownload
            && automaticCaptureAllowedForDownload(record.url, record.referrer)) {
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
              terminalFilenameWait,
              record,
              session
            );
            continue;
          }
          terminalFilenameWait.cancel();
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

function resolveMediaFetchTarget(tab, requestedURL, options = {}) {
  const handoffId = nextMediaHandoffId();
  const directManifestURL = normalizeMediaManifestURL(requestedURL);
  const canonicalPageURL = normalizePageMediaURL(tab?.url);
  if (options.preferSrcUrl === true) {
    // A context-menu link is an explicit user-selected source. Discovery of
    // the active tab must not replace it with an unrelated player manifest.
    return {
      handoffId,
      session: null,
      target: {
        url: requestedURL,
        referer: normalizeObservedMediaReferer(canonicalPageURL, requestedURL),
        headers: []
      }
    };
  }
  if (directManifestURL) {
    return {
      handoffId,
      session: null,
      target: {
        url: directManifestURL,
        referer: normalizeObservedMediaReferer(canonicalPageURL, directManifestURL),
        headers: []
      }
    };
  }

  const tabId = mediaDiscoveryTabId(tab?.id);
  if (tabId === null) {
    return {
      handoffId,
      session: null,
      target: {
        url: requestedURL,
        referer: normalizeObservedMediaReferer(requestedURL),
        headers: []
      }
    };
  }

  const session = startMediaDiscoverySession({
    tabId,
    windowId: mediaDiscoveryWindowId(tab?.windowId),
    tab,
    handoffId,
    keepAlivePort: options._mediaDiscoveryKeepAlivePort,
    canonicalURL: canonicalPageURL,
    fallbackURL: requestedURL,
    fallbackReferer: canonicalPageURL || requestedURL
  });
  return {
    handoffId: session.handoffId || handoffId,
    session,
    target: {
      url: requestedURL,
      referer: canonicalPageURL || requestedURL,
      headers: []
    }
  };
}

function mediaFetchRequestKey(tab, options = {}) {
  const tabId = mediaDiscoveryTabId(tab?.id);
  if (tabId === null) {
    return null;
  }
  const requestedURL = options.preferSrcUrl === true
    ? normalizePageMediaURL(options.srcUrl) || normalizePageMediaURL(tab?.url)
    : normalizePageMediaURL(tab?.url) || normalizePageMediaURL(options.srcUrl);
  return `${tabId}\u0000${requestedURL || ""}`;
}

function fetchMediaForTab(tab, options = {}) {
  const requestKey = mediaFetchRequestKey(tab, options);
  if (requestKey !== null) {
    const existing = activeMediaFetchHandoffs.get(requestKey);
    if (existing) {
      return existing;
    }
  }

  const promise = fetchMediaForTabInternal(tab, options);
  if (requestKey === null) {
    return promise;
  }

  activeMediaFetchHandoffs.set(requestKey, promise);
  const clear = () => {
    if (activeMediaFetchHandoffs.get(requestKey) === promise) {
      activeMediaFetchHandoffs.delete(requestKey);
    }
  };
  void promise.then(result => {
    if (result?.discoveryDone?.then) {
      void result.discoveryDone.then(clear, clear);
      return;
    }
    clear();
  }, clear);
  return promise;
}

function connectMediaDiscoveryKeepAlive(tabId) {
  if (mediaDiscoveryTabId(tabId) === null || typeof chrome.tabs?.connect !== "function") {
    return null;
  }
  try {
    // A context-menu event has no response channel of its own. Keep a
    // bounded port to the originating content script open for the duration
    // of discovery so an MV3 service worker cannot be discarded while its
    // eight-second session is waiting for requests.
    const port = chrome.tabs.connect(tabId, {
      frameId: 0,
      name: MEDIA_DISCOVERY_KEEPALIVE_PORT
    });
    port?.onMessage?.addListener(() => {});
    return port;
  } catch (error) {
    return null;
  }
}

function releaseMediaDiscoveryKeepAlive(port) {
  try {
    port?.disconnect?.();
  } catch (error) {
    // The browser may already have disconnected a restricted or closed tab.
  }
}

async function revalidateMediaFetchTab(tab, expectedDocumentId = null) {
  const tabId = mediaDiscoveryTabId(tab?.id);
  if (tabId === null) {
    return tab;
  }

  const originalURL = normalizePageMediaURL(tab?.url);
  if (!originalURL) {
    return null;
  }

  let currentTab = tab;
  if (typeof chrome.tabs?.get === "function") {
    const result = await callExtensionApi(chrome.tabs, "get", [tabId]);
    if (!result.ok || !result.value || typeof result.value !== "object") {
      return null;
    }
    currentTab = result.value;
  }

  if (mediaDiscoveryTabId(currentTab.id) !== tabId
    || normalizePageMediaURL(currentTab.url) !== originalURL) {
    return null;
  }
  // The discovery action is scoped to the active tab. Recheck the browser's
  // tab state immediately before handoff so a delayed activation event cannot
  // turn a background-tab request into a media transfer.
  if (currentTab.active === false) {
    return null;
  }

  const originalWindowId = mediaDiscoveryWindowId(tab.windowId);
  const currentWindowId = mediaDiscoveryWindowId(currentTab.windowId);
  if (originalWindowId !== null && originalWindowId !== currentWindowId) {
    return null;
  }
  if (expectedDocumentId !== null) {
    const documentId = await requestMediaDocumentIdentity(tabId, currentWindowId);
    if (documentId !== expectedDocumentId) {
      return null;
    }
  }
  return currentTab;
}

async function fetchMediaForTabInternal(tab, options = {}) {
  // Popup messaging channels close as soon as the popup is dismissed. Keep a
  // bounded port to the originating content script for every media fetch so
  // an MV3 service worker cannot be suspended during discovery or handoff.
  const keepAlivePort = connectMediaDiscoveryKeepAlive(tab?.id);
  const handoffState = { keepAliveTransferred: false };
  try {
    return await performMediaFetchForTab(tab, {
      ...options,
      _mediaDiscoveryKeepAlivePort: keepAlivePort,
      _mediaHandoffState: handoffState
    });
  } finally {
    if (!handoffState.keepAliveTransferred) {
      releaseMediaDiscoveryKeepAlive(keepAlivePort);
    }
  }
}

async function performMediaFetchForTab(tab, options = {}) {
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

  let mediaResolution;
  try {
    mediaResolution = resolveMediaFetchTarget(tab, pageURL, options);
  } catch (error) {
    // Discovery is an optional source of request context. A failed content
    // snapshot or observer must not prevent the existing page handoff.
    mediaResolution = {
      handoffId: nextMediaHandoffId(),
      session: null,
      target: {
        url: pageURL,
        referer: pageURL,
        headers: []
      }
    };
  }

  const mediaTarget = mediaResolution.target;
  const discoverySession = mediaResolution.session;
  if (discoverySession?.invalidated === true) {
    settleMediaDiscoveryInitialHandoff(discoverySession, false);
    return { accepted: false, ambiguous: false };
  }
  if (discoverySession && !discoverySession.closed) {
    if (discoverySession.initialHandoffStarted) {
      const sharedResult = await discoverySession.initialHandoffPromise;
      const result = {
        accepted: sharedResult.accepted === true,
        ambiguous: sharedResult.ambiguous === true
      };
      Object.defineProperty(result, "discoveryDone", {
        value: discoverySession.donePromise,
        enumerable: false
      });
      return result;
    }
    discoverySession.initialHandoffStarted = true;
    const incomingKeepAlivePort = options._mediaDiscoveryKeepAlivePort || null;
    // A request for the same page can already be sharing an active session.
    // Keep the original owner of its port; otherwise the newer caller would
    // overwrite a live reference that the first caller's finally block no
    // longer releases.
    const canAdoptKeepAlive = !discoverySession.keepAlivePort
      || discoverySession.keepAlivePort === incomingKeepAlivePort;
    if (canAdoptKeepAlive) {
      discoverySession.keepAlivePort = incomingKeepAlivePort;
    }
    if (canAdoptKeepAlive && options._mediaHandoffState) {
      options._mediaHandoffState.keepAliveTransferred = true;
    }
  }

  let handoffTab;
  try {
    // The initial page handoff is intentionally not gated on the eventual
    // document identity. Discovery will bind and revalidate that identity
    // before sending a discovered manifest update.
    handoffTab = await revalidateMediaFetchTab(tab, null);
  } catch (error) {
    handoffTab = null;
  }
  if (!handoffTab) {
    if (discoverySession && !discoverySession.closed) {
      discoverySession.invalidated = true;
      finishMediaDiscoverySession(discoverySession);
    }
    settleMediaDiscoveryInitialHandoff(discoverySession, false);
    return { accepted: false, ambiguous: false };
  }

  let requestMayHaveBeenSent = false;
  let accepted = false;
  try {
    accepted = await sendToFirelink([mediaTarget.url], mediaTarget.referer, {
      allowProtocolFallback: true,
      cookieStoreId: handoffTab?.cookieStoreId,
      incognito: handoffTab?.incognito === true,
      // yt-dlp handles media cookies through Firelink's configured browser
      // source. A full page Cookie header can exceed YouTube's request limit.
      forwardCookies: false,
      includeUserAgent: false,
      mediaHeaders: mediaTarget.headers,
      media: true,
      mediaHandoffId: mediaResolution.handoffId,
      mediaPhase: MEDIA_PHASE_INITIAL,
      onLegacyMediaFallback: used => {
        if (used && discoverySession) {
          discoverySession.twoPhaseMediaSupported = false;
          // A legacy desktop cannot consume the discovered phase. End the
          // browser observer immediately instead of holding the service
          // worker and keepalive port for the full discovery window.
          finishMediaDiscoverySession(discoverySession);
        }
      },
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

  if (discoverySession) {
    settleMediaDiscoveryInitialHandoff(
      discoverySession,
      accepted,
      requestMayHaveBeenSent && !accepted
    );
    if (!accepted && !discoverySession.closed) {
      discoverySession.invalidated = true;
      finishMediaDiscoverySession(discoverySession);
    }
  }

  if (accepted && options.notifyOnSuccess === true) {
    notify(
      backgroundText("notifications", "mediaTitle", "Firelink Media Fetch"),
      backgroundText("notifications", "mediaSent", "Media page sent to Firelink.")
    );
  }

  const result = {
    accepted,
    ambiguous: requestMayHaveBeenSent && !accepted
  };
  if (discoverySession) {
    Object.defineProperty(result, "discoveryDone", {
      value: discoverySession.donePromise,
      enumerable: false
    });
  }
  return result;
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

async function captureAutomaticTorrent(request, sender) {
  const browserLocalTorrent = request?.browserLocalTorrent === true;
  const url = normalizeURL(request?.url || request?.href);
  const referer = typeof sender?.tab?.url === "string" ? sender.tab.url : "";
  if (browserLocalTorrent) {
    const sourceURL = normalizePageMediaURL(request?.sourceURL || request?.sourceUrl)
      || normalizePageMediaURL(referer);
    const filename = typeof request?.filename === "string" ? request.filename : "";
    const torrentBytesBase64 = request?.torrentBytesBase64;
    if (typeof request?.url === "string" && !isBrowserLocalTorrentURL(request.url)) {
      return { intercepted: false, ambiguous: false };
    }
    if (!sourceURL
      || !isValidTorrentBytesPayload(torrentBytesBase64)
      || !isTorrentFilename(filename)) {
      return { intercepted: false, ambiguous: false };
    }
    await settingsLoaded;
    // A blob/data document can be the sender tab's URL. It is not a site
    // policy origin, so evaluate the page URL recovered by the content script
    // instead of letting an opaque referrer bypass a site exclusion.
    if (!automaticCaptureAllowedForDownload(sourceURL, sourceURL)) {
      return { intercepted: false, ambiguous: false };
    }

    let requestMayHaveBeenSent = false;
    let accepted = false;
    try {
      accepted = await sendToFirelink([sourceURL], sourceURL, {
        allowProtocolFallback: true,
        captureMode: "automatic",
        notifyOnFailure: false,
        torrent: true,
        torrentBytesBase64,
        filename,
        onRequestMayHaveBeenSent: () => {
          requestMayHaveBeenSent = true;
        }
      });
    } catch (error) {
      // The content script has already suppressed the browser action. Treat
      // an unclassified transport failure as ambiguous because the signed
      // request may have reached the desktop before the error surfaced.
      requestMayHaveBeenSent = true;
    }

    const ambiguous = requestMayHaveBeenSent && !accepted;
    if (ambiguous) {
      notify(
        backgroundText("notifications", "handoffFailedTitle", "Firelink Handoff Failed"),
        backgroundText(
          "notifications",
          "ambiguousManual",
          "Firelink may have received this download. Check Firelink before trying again."
        )
      );
    }
    return {
      intercepted: accepted || ambiguous,
      ambiguous
    };
  }

  const magnet = isMagnetURL(url);
  const torrent = isTorrentURL(url);
  const filename = typeof request?.filename === "string" ? request.filename : "";
  const filenameTorrent = isTorrentFilename(filename);
  if (!url || (!magnet && !torrent && !filenameTorrent)) {
    return { intercepted: false };
  }

  await settingsLoaded;
  if (!automaticCaptureAllowedForDownload(url, referer)) {
    if (!magnet) {
      return { intercepted: false, ambiguous: false };
    }
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
      filename: filename || undefined,
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
    if (!magnet) {
      return { intercepted: false, ambiguous: false };
    }
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

// Keep the original action as a compatibility alias for content scripts from
// earlier extension versions while routing both kinds through one lifecycle.
async function captureAutomaticMagnet(request, sender) {
  return captureAutomaticTorrent(request, sender);
}

const selectionCaptureSources = new Set(["live", "snapshot", "text-fallback", "none"]);

function normalizeSelectionResponse(response) {
  if (!response || !Array.isArray(response.links)) {
    return null;
  }
  return {
    links: normalizeURLList(response.links),
    selectionText: typeof response.selectionText === "string"
      ? response.selectionText
      : "",
    captureSource: selectionCaptureSources.has(response.captureSource)
      ? response.captureSource
      : "live"
  };
}

function contextMenuFrameId(info) {
  return Number.isSafeInteger(info?.frameId) && info.frameId >= 0
    ? info.frameId
    : 0;
}

function sendSelectionTextLinks(info, tab, selectionText = info?.selectionText) {
  const urls = extractURLsFromText(selectionText);
  if (urls.length === 0) {
    return urls;
  }
  sendContextMenuHandoff(urls, tab?.url || "", {
    cookieStoreId: tab?.cookieStoreId,
    incognito: tab?.incognito === true,
    batch: true,
    batchName: tab?.title
  });
  return urls;
}

function handleSelectedLinkFallback(info, tab, frameId, selectionText, reason) {
  const urls = sendSelectionTextLinks(info, tab, selectionText);
  if (urls.length > 0) {
    reportSelectedLinkCapture("text-fallback", frameId, "text-fallback", urls.length, reason);
    return true;
  }
  reportSelectedLinkCapture("no-links", frameId, "none", 0, reason);
  notifyNoSelectedLinks();
  return false;
}

function handleSelectedLinkResponse(response, info, tab, frameId, reason) {
  if (response?.links?.length > 0) {
    reportSelectedLinkCapture(
      "handoff",
      frameId,
      response.captureSource,
      response.links.length,
      "anchor-links"
    );
    sendContextMenuHandoff(response.links, tab?.url || "", {
      cookieStoreId: tab?.cookieStoreId,
      incognito: tab?.incognito === true,
      batch: true,
      batchName: tab?.title
    });
    return true;
  }

  const selectionText = response?.selectionText || info?.selectionText || "";
  return handleSelectedLinkFallback(info, tab, frameId, selectionText, reason);
}

async function requestSelectionResponse(tabId, frameId) {
  const messageArguments = [
    tabId,
    { action: SELECTION_LINK_MESSAGE_ACTION },
    { frameId }
  ];
  const direct = await callExtensionApi(chrome.tabs, "sendMessage", messageArguments);
  const directResponse = direct.ok ? normalizeSelectionResponse(direct.value) : null;
  if (directResponse) {
    return { response: directResponse, reason: "message" };
  }

  if (!chrome.scripting?.executeScript) {
    return {
      response: null,
      reason: direct.ok ? "malformed-message" : "message-unavailable"
    };
  }

  const injected = await callExtensionApi(chrome.scripting, "executeScript", [{
    target: { tabId, frameIds: [frameId] },
    files: ["content.js"]
  }]);
  if (!injected.ok) {
    return { response: null, reason: "injection-unavailable" };
  }

  const retry = await callExtensionApi(chrome.tabs, "sendMessage", messageArguments);
  const retryResponse = retry.ok ? normalizeSelectionResponse(retry.value) : null;
  if (retryResponse) {
    return { response: retryResponse, reason: "injected-message" };
  }
  return {
    response: null,
    reason: retry.ok ? "malformed-injected-message" : "injected-message-unavailable"
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "captureAutomaticMagnet"
    || request?.action === "captureAutomaticTorrent") {
    captureAutomaticTorrent(request, _sender)
      .then(result => sendResponse(result))
      .catch(() => {
        // The content script already suppressed the user click. An unknown
        // background failure must fail closed rather than replaying a torrent
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

  if (request?.action === "reportAutomaticMagnetTimeout"
    || request?.action === "reportAutomaticTorrentTimeout") {
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

  const frameId = contextMenuFrameId(info);
  if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || !chrome.tabs?.sendMessage) {
    handleSelectedLinkFallback(info, tab, frameId, info.selectionText, "tab-or-messaging-unavailable");
    return;
  }

  void requestSelectionResponse(tab.id, frameId)
    .then(result => {
      if (result.response) {
        handleSelectedLinkResponse(
          result.response,
          info,
          tab,
          frameId,
          result.reason
        );
        return;
      }
      handleSelectedLinkFallback(
        info,
        tab,
        frameId,
        info.selectionText,
        result.reason
      );
    })
    .catch(() => {
      handleSelectedLinkFallback(
        info,
        tab,
        frameId,
        info.selectionText,
        "selection-capture-failed"
      );
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
  const mime = change.mime?.current;
  if (typeof mime === "string" && mime) {
    fields.mime = mime;
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

  let retainedCompletedTorrent = false;
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
    retainedCompletedTorrent = terminal
      && ["paused", "ready"].includes(currentRecord.phase)
      && isCompletedTorrentDownload(currentRecord, downloadItem, fields);
    if (retainedCompletedTorrent) {
      return {
        ...current,
        [String(change.id)]: {
          ...currentRecord,
          ...fields,
          phase: "ready",
          updatedAt: Date.now()
        }
      };
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
  if (retainedCompletedTorrent) {
    void recoverPendingCaptures();
  }
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
  const terminal = isTerminalDownloadChange(change);
  const resumed = change.paused?.current === false && !terminal;
  const terminalMetadataDefinitelyTorrent = isTorrentMime(change.mime?.current)
    || isTorrentURL(change.finalUrl?.current);
  if (resumed || terminalMetadataDefinitelyTorrent) {
    settleDownloadFilenameWait(change.id);
  }

  const active = activeAutomaticCaptures.has(change.id);
  if (active) {
    const session = activeAutomaticCaptures.get(change.id);
    Object.assign(session.observedDownloadFields, fields);
    if (Object.keys(fields).length > 0) {
      void updatePendingCapture(change.id, fields).catch(() => {});
    }
    const stateOnlyInterruption = state === "interrupted"
      && change.paused?.current === undefined;
    const cleanupResumeWithoutState = resumed
      && session?.cleanupTerminalExpected
      && state === undefined;
    if (stateOnlyInterruption || cleanupResumeWithoutState) {
      queueActiveAutomaticCaptureReconciliation(change.id, session);
    } else if (resumed || terminal) {
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
      // The event is only a delta. Firefox can report an interruption or a
      // pause transition in separate events, so reconcile the persisted
      // record against the current item rather than trusting stale booleans
      // from the event that triggered this lookup.
      const currentTerminal = isTerminalDownload(downloadItem);
      const currentResumed = downloadItem.paused === false && !currentTerminal;
      return reconcilePendingDownloadChange(
        change,
        downloadItem,
        fields,
        currentResumed,
        currentTerminal
      );
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

  const record = createPendingCaptureRecord(downloadItem);
  let completedTorrent = null;
  if (session.terminal && session.terminalState === "complete") {
    completedTorrent = await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    });
  }
  if (automaticCaptureInvalidated(session) && !completedTorrent) {
    activeAutomaticCaptures.delete(downloadItem.id);
    filenameWait.cancel();
    return;
  }
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
  if (!completedTorrent
    && session.terminal
    && session.terminalState === "complete") {
    completedTorrent = await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    });
  }
  if ((automaticCaptureInvalidated(session) && !completedTorrent)
    || !automaticCaptureAllowedForDownload(record.url, record.referrer)) {
    const removed = await removePendingCapture(record.id);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }

  // A very small torrent can already be complete by the time onCreated is
  // delivered. It is still eligible for a one-time handoff, but must never
  // be sent through the pause/cancel/erase cleanup used for active items.
  if (completedTorrent
    || downloadItem.state === "complete"
    || session.terminalState === "complete") {
    if (!completedTorrent) {
      // Firefox may deliver the terminal state before it publishes the final
      // filename or MIME. Let the existing metadata waiter settle, then read
      // the owned item again so opaque torrent downloads are not discarded
      // merely because their initial name was weak.
      const settledFilename = await filenameWait.promise;
      if (settledFilename) {
        record.filename = settledFilename;
      }
      completedTorrent = await findOwnedAutomaticDownload(record, session, {
        allowCompletedTorrent: true
      });
    }
    const isCompletedTorrent = completedTorrent
      || isDefiniteTorrentDownload(record, downloadItem, session.observedDownloadFields);
    if (isCompletedTorrent) {
      await handleAutomaticCapture(downloadItem, filenameWait, record, session);
      return;
    }

    // Completed ordinary files are outside the terminal torrent fallback.
    // Drop only this verified record and leave the browser's completed file
    // untouched.
    const removed = await removePendingCapture(record.id);
    if (!removed) {
      schedulePendingCaptureRecovery();
    }
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }

  session.awaitingPauseConfirmation = true;
  const paused = await runDownloadAction("pause", downloadItem.id);
  if (!paused) {
    session.awaitingPauseConfirmation = false;
    const completedTorrent = await findOwnedAutomaticDownload(record, session, {
      allowCompletedTorrent: true
    });
    if (completedTorrent) {
      await handleAutomaticCapture(downloadItem, filenameWait, record, session);
      return;
    }
    await removePendingCaptureAndResume(record.id, session);
    activeAutomaticCaptures.delete(record.id);
    filenameWait.cancel();
    return;
  }
  // A resume can race with the pause RPC itself. If the browser reported user
  // intent while that RPC was in flight, restore it before any handoff work;
  // otherwise the extension could leave a user-resumed download paused.
  if (automaticCaptureInvalidated(session)) {
    let completedTorrent = null;
    if (session.terminal && session.terminalState === "complete") {
      completedTorrent = await findOwnedAutomaticDownload(record, session, {
        allowCompletedTorrent: true
      });
    }
    if (completedTorrent) {
      await handleAutomaticCapture(downloadItem, filenameWait, record, session);
      return;
    }
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
