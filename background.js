// background.js

// IMPORTANT(Backward Compatibility):
// When updating this extension to use a new Firelink API version (e.g., v2), ensure that the
// main Firelink app's LocalExtensionServer continues to support older versions (like v1). 
// Extension store approvals can take days, and during that time, older extensions MUST continue 
// working with the newly updated Firelink app.
const FIRELINK_PORTS = Array.from({ length: 11 }, (_, index) => 6412 + index);
const FIRELINK_EXTENSION_TOKEN = "firelink-extension-v1";
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

// Default settings
const defaultSettings = {
  globalCapture: true,
  siteToggles: {} // hostname -> boolean (true if capture is disabled for this site)
};

// Cached settings for synchronous access
let cachedSettings = { ...defaultSettings };

// Sync settings
chrome.storage.local.get(['globalCapture', 'siteToggles'], (result) => {
  if (result.globalCapture !== undefined) cachedSettings.globalCapture = result.globalCapture;
  if (result.siteToggles !== undefined) cachedSettings.siteToggles = result.siteToggles;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.globalCapture) cachedSettings.globalCapture = changes.globalCapture.newValue;
    if (changes.siteToggles) cachedSettings.siteToggles = changes.siteToggles.newValue;
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
async function sendToFirelink(urls, referer = "") {
  const normalizedURLs = normalizeURLList(urls);
  if (normalizedURLs.length === 0) {
    return false;
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
          "X-Firelink-Extension": FIRELINK_EXTENSION_TOKEN
        },
        body: JSON.stringify(payload)
      }).then(res => {
        if (!res.ok) throw new Error("Not OK");
        return true;
      })
    );

    // Fire all requests concurrently and resolve as soon as one succeeds
    await Promise.any(fetchPromises);
    return true;
  } catch (error) {
    // All local ports failed (app might be closed), fallback to deep link
    if (normalizedURLs.length > 0) {
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
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
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
chrome.downloads.onCreated.addListener((downloadItem) => {
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
    // Cancel synchronously immediately to eliminate the browser's native download UI flash
    chrome.downloads.cancel(downloadItem.id, () => {
      // Erase the download to prevent "Canceled" items from cluttering the browser UI
      chrome.downloads.erase({ id: downloadItem.id });
    });
    sendToFirelink([downloadItem.url], downloadItem.referrer);
  }
});
