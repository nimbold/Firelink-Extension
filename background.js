// background.js
const FIRELINK_PORTS = Array.from({ length: 11 }, (_, index) => 6412 + index);
const FIRELINK_EXTENSION_TOKEN = "firelink-extension-v1";
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:", "sftp:"]);

// Default settings
const defaultSettings = {
  globalCapture: false,
  siteToggles: {} // hostname -> boolean (true if capture is disabled for this site)
};

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

  try {
    const payload = {
      urls: normalizedURLs,
      referer: referer
    };
    
    for (const port of FIRELINK_PORTS) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/download`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Firelink-Extension": FIRELINK_EXTENSION_TOKEN
          },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          return true;
        }
      } catch (error) {
        // Try the next Firelink fallback port.
      }
    }
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
  } catch (error) {
    console.warn("Firelink is not accepting extension requests.");
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
  chrome.storage.local.get(['globalCapture', 'siteToggles'], (settings) => {
    const globalCapture = settings.globalCapture || false;
    const siteToggles = settings.siteToggles || {};
    
    let hostname = "";
    try {
      hostname = new URL(downloadItem.referrer || downloadItem.url).hostname;
    } catch (e) {
      // Invalid URL
    }

    // Check if capture is disabled for this specific site
    const siteCaptureDisabled = siteToggles[hostname] === true;

    if (globalCapture && !siteCaptureDisabled) {
      sendToFirelink([downloadItem.url], downloadItem.referrer).then((accepted) => {
        if (accepted) {
          chrome.downloads.cancel(downloadItem.id);
        }
      });
    }
  });
});
