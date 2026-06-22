const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

const defaultSettings = {
  globalCapture: true,
  siteToggles: {},
  extensionToken: ""
};

let cachedSettings = { ...defaultSettings };

const settingsLoaded = new Promise(resolve => {
  chrome.storage.local.get(
    ["globalCapture", "siteToggles", "extensionToken"],
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
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    ["globalCapture", "siteToggles", "extensionToken"],
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

function triggerDeepLink(normalizedURLs) {
  const appUrl = `firelink://add?url=${encodeURIComponent(normalizedURLs.join("\n"))}`;
  return new Promise(resolve => {
    chrome.tabs.create({ url: appUrl, active: false }, () => {
      if (chrome.runtime.lastError) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: "Could Not Open Firelink",
          message: "The Firelink app protocol is not registered. Open or reinstall Firelink, then retry."
        });
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
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
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Firelink Setup Required",
        message: "Please click the Firelink extension icon and paste the pairing token."
      });
    }
    return false;
  }

  const cookieString = normalizedURLs.length === 1
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

  try {
    await FirelinkProtocol.signedFetch("/download", cachedSettings.extensionToken, {
      method: "POST",
      payload
    });
    return true;
  } catch (error) {
    if (error.serverReached && error.status === 403) {
      if (notifyOnFailure) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: "Firelink Connection Rejected",
          message: "Your pairing token is invalid. Update it in the Firelink extension popup."
        });
      }
      return false;
    }

    const canUseProtocol = allowProtocolFallback
      && (!error.serverReached || error.status >= 500);
    if (canUseProtocol) {
      return triggerDeepLink(normalizedURLs);
    }

    if (notifyOnFailure) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Firelink Handoff Failed",
        message: error.serverReached
          ? "Firelink rejected the request. No download was added."
          : "Firelink is unavailable. No download was added."
      });
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
      allowProtocolFallback: false,
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
