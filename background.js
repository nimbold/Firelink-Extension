// background.js

// IMPORTANT(Compatibility):
// Store approvals can take days. If the local API changes, keep the native app compatible
// with the currently published extension until the new extension has reached users.
const FIRELINK_PORTS = Array.from({ length: 11 }, (_, index) => 6412 + index);
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

// Default settings
const defaultSettings = {
  globalCapture: true,
  siteToggles: {}, // hostname -> boolean (true if capture is disabled for this site)
  extensionToken: "" // Empty by default
};

// Cached settings for synchronous access
let cachedSettings = { ...defaultSettings };

// Sync settings
let settingsLoadedPromise = new Promise((resolve) => {
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
  chrome.storage.local.get(['globalCapture', 'siteToggles'], (result) => {
    if (result.globalCapture === undefined) {
      chrome.storage.local.set(defaultSettings);
    }
  });

  // Create context menus
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

function normalizeURL(rawURL) {
  if (typeof rawURL !== "string") {
    return null;
  }

  const trimmed = rawURL.trim().replace(/^[<("'[]+|[>)"'\].,;:!?]+$/g, "");
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
    return triggerDeepLink();
  }

  const payload = {
    urls: normalizedURLs,
    referer: referer
  };

  try {
    const fetchPromises = FIRELINK_PORTS.map(port =>
      fetch(`http://127.0.0.1:${port}/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firelink-Extension": cachedSettings.extensionToken
        },
        body: JSON.stringify(payload)
      }).then(res => {
        if (res.status === 403) {
          throw new Error("FORBIDDEN");
        }
        if (!res.ok) throw new Error("Not OK");
        return true;
      })
    );

    // Fire all requests concurrently and resolve as soon as one succeeds
    await Promise.any(fetchPromises);
    return true;
  } catch (error) {
    // If the app explicitly rejected the token, DO NOT fallback to deep link
    if (error.errors && error.errors.some(e => e.message === "FORBIDDEN")) {
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

    // All local ports failed (app might be closed), fallback to deep link
    return triggerDeepLink();
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await settingsLoadedPromise;

  if (info.menuItemId === "download-with-firelink") {
    if (info.linkUrl) {
      sendToFirelink([info.linkUrl], tab.url);
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

// Listen for downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  await settingsLoadedPromise;

  const globalCapture = cachedSettings.globalCapture || false;
  const siteToggles = cachedSettings.siteToggles || {};

  let hostname = "";
  try {
    hostname = new URL(downloadItem.referrer || downloadItem.url).hostname;
  } catch (e) {
    // Invalid URL
  }

  // Check if capture is disabled for this specific site
  const siteCaptureDisabled = siteToggles[hostname] === true;

  if (globalCapture && !siteCaptureDisabled) {
    const normalizedURLs = normalizeURLList([downloadItem.url]);
    if (normalizedURLs.length === 0) return;

    // Pause the download immediately to prevent completion while we ping Firelink
    chrome.downloads.pause(downloadItem.id, () => {
      if (chrome.runtime.lastError) {
        // Ignored, might be already completed or cancelled by something else
      }
      
      sendToFirelink([downloadItem.url], downloadItem.referrer, { allowProtocolFallback: true, silent: true }).then((accepted) => {
        if (accepted) {
          chrome.downloads.cancel(downloadItem.id, () => {
            chrome.downloads.erase({ id: downloadItem.id });
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        } else {
          // Firelink rejected or is offline, let the browser resume the download
          chrome.downloads.resume(downloadItem.id, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      });
    });
  }
});
