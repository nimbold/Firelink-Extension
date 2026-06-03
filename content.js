// content.js
(() => {
  const allowedSchemes = new Set(["http:", "https:", "ftp:", "sftp:"]);

  function normalizedDownloadURL(rawURL) {
    try {
      const url = new URL(rawURL, document.baseURI);
      return allowedSchemes.has(url.protocol) ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  if (!globalThis.firelinkSelectionLinkHandlerInstalled) {
    globalThis.firelinkSelectionLinkHandlerInstalled = true;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "extractSelectionLinks") {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          sendResponse({ links: [] });
          return;
        }

        const links = new Set();

        // Extract a tags from the selected range
        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          const container = document.createElement("div");
          container.appendChild(range.cloneContents());

          const anchors = container.querySelectorAll("a");
          anchors.forEach(a => {
            const url = normalizedDownloadURL(a.getAttribute("href"));
            if (url) {
              links.add(url);
            }
          });
        }

        sendResponse({ links: Array.from(links) });
      }
    });
  }
})();
