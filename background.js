// background.js

const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

// Default settings
const defaultSettings = {
  globalCapture: true,
  siteToggles: {}, // hostname -> boolean (true if capture is disabled for this site)
  extensionToken: "" // Empty by default
};

// Cached settings for synchronous access
let cachedSettings = { ...defaultSettings };

const settingsLoaded = new Promise(resolve => {
  chrome.storage.local.get(['globalCapture', 'siteToggles', 'extensionToken'], (result) => {
    if (result.globalCapture !== undefined) cachedSettings.globalCapture = result.globalCapture;
    if (result.siteToggles !== undefined) cachedSettings.siteToggles = result.siteToggles;
    if (result.extensionToken !== undefined) cachedSettings.extensionToken = result.extensionToken;
    resolve();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.globalCapture) cachedSettings.globalCapture = changes.globalCapture.newValue;
    if (changes.siteToggles) cachedSettings.siteToggles = changes.siteToggles.newValue;
    if (changes.extensionToken) cachedSettings.extensionToken = changes.extensionToken.newValue;
  }
});

// Initialize settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['globalCapture', 'siteToggles', 'extensionToken'], (result) => {
    const missingSettings = {};
    for (const [key, value] of Object.entries(defaultSettings)) {
      if (result[key] === undefined) missingSettings[key] = value;
    }
    if (Object.keys(missingSettings).length > 0) {
      chrome.storage.local.set(missingSettings);
    }
  });

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
  const trailingPunctuation = new Set([">", ")", "\"", "'", "]", ".", ",", ";", ":", "!", "?"]);
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

// Function to send URLs to Firelink
async function sendToFirelink(urls, referer = "", options = {}) {
  await settingsLoaded;
  const silent = options.silent === true;
  const allowProtocolFallback = options.allowProtocolFallback !== false;
  const normalizedURLs = normalizeURLList(urls);
  if (normalizedURLs.length === 0) {
    return false;
  }

  const triggerDeepLink = () => {
    if (allowProtocolFallback) {
      const appUrl = `firelink://add?url=${encodeURIComponent(normalizedURLs.join('\n'))}`;
      if (typeof document !== 'undefined') {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = appUrl;
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 5000);
      } else {
        chrome.tabs.create({ url: appUrl, active: false });
      }
      return true;
    }
    return false;
  };

  if (!cachedSettings.extensionToken) {
    if (!silent) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Firelink Setup Required",
        message: "Please click the Firelink extension icon and paste your pairing token to connect."
      });
    }
    return false;
  }

  let cookieString = "";
  try {
    const mainUrl = normalizedURLs[0];
    if (chrome.cookies) {
      const cookies = await new Promise(resolve => {
        chrome.cookies.getAll({ url: mainUrl }, resolve);
      });
      if (cookies && cookies.length > 0) {
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    }
  } catch (e) {
    // Ignore error fetching cookies
  }

  const payload = {
    urls: normalizedURLs,
    referer: referer,
    silent: silent,
    filename: options.filename,
    headers: {
      "User-Agent": navigator.userAgent,
      ...(cookieString ? { "Cookie": cookieString } : {})
    }
  };
  try {
    await FirelinkProtocol.signedFetch("/download", cachedSettings.extensionToken, {
      method: "POST",
      payload
    });
    return true;
  } catch (error) {
    if (error.serverReached && error.status === 403) {
      if (!silent) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: "Firelink Connection Rejected",
          message: "Your pairing token is invalid. Please update the token in the Firelink extension popup."
        });
      }
      return false;
    }

    return error.serverReached ? false : triggerDeepLink();
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "download-with-firelink") {
    if (info.linkUrl) {
      sendToFirelink([info.linkUrl], tab?.url || "");
    }
  } else if (info.menuItemId === "download-selected-with-firelink") {
    // We need to inject a script to get the selected HTML/links
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    }, () => {
      if (chrome.runtime.lastError) {
        const urls = extractURLsFromText(info.selectionText);
        if (urls.length > 0) {
          sendToFirelink(urls, tab.url);
        }
        return;
      }

      // Send a message to the content script to perform the extraction
      chrome.tabs.sendMessage(tab.id, { action: "extractSelectionLinks" }, (response) => {
        if (chrome.runtime.lastError) {
          const urls = extractURLsFromText(info.selectionText);
          if (urls.length > 0) {
            sendToFirelink(urls, tab.url);
          }
          return;
        }

        if (response && response.links && response.links.length > 0) {
          sendToFirelink(response.links, tab.url);
        } else {
          // Fallback: If no links were found by the content script, try to parse the raw text
          if (info.selectionText) {
            const urls = extractURLsFromText(info.selectionText);
            if (urls.length > 0) {
              sendToFirelink(urls, tab.url);
            }
          }
        }
      });
    });
  }
});

function runDownloadAction(action, ...args) {
  return new Promise(resolve => {
    chrome.downloads[action](...args, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

// Listen for downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  await settingsLoaded;
  const globalCapture = cachedSettings.globalCapture === true;
  const siteToggles = cachedSettings.siteToggles || {};

  let hostname = "";
  try {
    hostname = new URL(downloadItem.referrer || downloadItem.url).hostname;
  } catch (e) {
    // Invalid URL
  }

  // Check if capture is disabled for this specific site
  const siteCaptureDisabled = siteToggles[hostname] === true;

  if (!globalCapture || siteCaptureDisabled || !cachedSettings.extensionToken) return;

  const filename = downloadItem.filename
    ? downloadItem.filename.replace(/^.*[\\/]/, '')
    : undefined;
  const paused = await runDownloadAction("pause", downloadItem.id);
  if (!paused) return;

  const accepted = await sendToFirelink(
    [downloadItem.url],
    downloadItem.referrer,
    {
      allowProtocolFallback: false,
      silent: false,
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
