const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

const defaultSettings = {
  globalCapture: true,
  siteToggles: {},
  extensionToken: "",
  launchTimeoutCount: 0,
  launchCooldownUntil: 0
};

let cachedSettings = { ...defaultSettings };
const LAUNCH_URL = "firelink://launch";
const LAUNCH_TIMEOUT_MS = 15000;
const LAUNCH_RETRY_MS = 500;
const LAUNCH_TIMEOUTS_BEFORE_COOLDOWN = 2;
const LAUNCH_COOLDOWN_MS = 60000;
let launchSession = null;

const settingsLoaded = new Promise(resolve => {
  chrome.storage.local.get(
    ["globalCapture", "siteToggles", "extensionToken", "launchTimeoutCount", "launchCooldownUntil"],
    result => {
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
    chrome.tabs.create({ url: LAUNCH_URL, active: false }, tab => {
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

function enqueueLaunchDelivery(token, payload, requiredProtocolVersion) {
  return new Promise(resolve => {
    if (!launchSession) {
      launchSession = {
        entries: [],
        running: false
      };
    }
    launchSession.entries.push({
      token,
      payload: Object.freeze({ ...payload, urls: Object.freeze([...payload.urls]) }),
      requiredProtocolVersion,
      resolve
    });
    if (!launchSession.running) {
      launchSession.running = true;
      void runLaunchSession(launchSession);
    }
  });
}

async function runLaunchSession(session) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let tabId = null;
  let launchFailed = false;
  let deliveryFailed = false;

  try {
    tabId = await createLaunchTab();
    if (tabId === null) {
      throw new Error("Firelink protocol is not registered");
    }
    await waitForFirelink(session.entries[0].token, deadline);

    let index = 0;
    while (index < session.entries.length) {
      const entry = session.entries[index];
      try {
        entry.result = await deliverAfterStartup(entry, deadline);
      } catch (error) {
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
    if (launchSession === session) {
      launchSession = null;
    }
    await closeLaunchTab(tabId);
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

  const shouldForwardCookies = captureMode === "automatic" && normalizedURLs.length === 1;
  const cookieString = shouldForwardCookies
    ? await collectCookieHeader(normalizedURLs[0], options.cookieStoreId)
    : "";

  const payload = {
    urls: normalizedURLs,
    referer,
    silent: captureMode === "automatic",
    filename: options.filename,
    headers: `User-Agent: ${navigator.userAgent}`,
    cookies: cookieString || undefined
  };

  const requiredProtocolVersion = captureMode === "automatic" ? 3 : undefined;

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
      return enqueueLaunchDelivery(cachedSettings.extensionToken, payload, requiredProtocolVersion);
    }

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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "download-with-firelink") {
    if (info.linkUrl) {
      sendToFirelink([info.linkUrl], tab?.url || "", {
        cookieStoreId: tab?.cookieStoreId
      });
    }
    return;
  }

  if (info.menuItemId !== "download-selected-with-firelink") {
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      files: ["content.js"]
    },
    () => {
      if (chrome.runtime.lastError) {
        const urls = extractURLsFromText(info.selectionText);
        if (urls.length > 0) {
          sendToFirelink(urls, tab.url, {
            cookieStoreId: tab.cookieStoreId
          });
        }
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        { action: "extractSelectionLinks" },
        response => {
          if (chrome.runtime.lastError) {
            const urls = extractURLsFromText(info.selectionText);
            if (urls.length > 0) {
              sendToFirelink(urls, tab.url, {
                cookieStoreId: tab.cookieStoreId
              });
            }
            return;
          }

          if (response?.links?.length > 0) {
            sendToFirelink(response.links, tab.url, {
              cookieStoreId: tab.cookieStoreId
            });
            return;
          }

          const urls = extractURLsFromText(info.selectionText);
          if (urls.length > 0) {
            sendToFirelink(urls, tab.url, {
              cookieStoreId: tab.cookieStoreId
            });
          }
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

chrome.downloads.onCreated.addListener(async downloadItem => {
  await settingsLoaded;

  if (!cachedSettings.extensionToken || !captureEnabledForURL(downloadItem.referrer || downloadItem.url)) {
    return;
  }

  const filename = downloadItem.filename
    ? downloadItem.filename.replace(/^.*[\\/]/, "")
    : undefined;
  const paused = await runDownloadAction("pause", downloadItem.id);
  if (!paused) {
    return;
  }

  const accepted = await sendToFirelink(
    [downloadItem.url],
    downloadItem.referrer,
    {
      allowProtocolFallback: true,
      captureMode: "automatic",
      cookieStoreId: downloadItem.cookieStoreId,
      notifyOnFailure: false,
      filename
    }
  );

  if (!accepted) {
    await runDownloadAction("resume", downloadItem.id);
    return;
  }

  await runDownloadAction("cancel", downloadItem.id);
  await runDownloadAction("erase", { id: downloadItem.id });
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Firelink Download Capture",
    message: "Download automatically forwarded to Firelink."
  });
});
