// background.js
const FIRELINK_SERVER_URL = "http://localhost:6412/download";

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

// Function to send URLs to Firelink
async function sendToFirelink(urls, referer = "") {
  try {
    const payload = {
      urls: Array.isArray(urls) ? urls : [urls],
      referer: referer
    };
    
    // Attempt to send to Firelink local server
    await fetch(FIRELINK_SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    console.log("Successfully sent to Firelink:", payload);
  } catch (error) {
    console.error("Failed to send to Firelink:", error);
    // Fallback logic could go here
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
      // Send a message to the content script to perform the extraction
      chrome.tabs.sendMessage(tab.id, { action: "extractSelectionLinks" }, (response) => {
        if (response && response.links && response.links.length > 0) {
          sendToFirelink(response.links, tab.url);
        } else {
          // Fallback: If no links were found by the content script, try to parse the raw text
          if (info.selectionText) {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const matches = info.selectionText.match(urlRegex);
            if (matches && matches.length > 0) {
              sendToFirelink(matches, tab.url);
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
      // Cancel the browser download
      chrome.downloads.cancel(downloadItem.id, () => {
        // Send to Firelink
        sendToFirelink([downloadItem.url], downloadItem.referrer);
      });
    }
  });
});
