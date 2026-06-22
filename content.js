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
      if (request.action !== "extractSelectionLinks") {
        return false;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        sendResponse({ links: [] });
        return false;
      }

      const links = new Set();
      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        container.querySelectorAll("a").forEach(anchor => {
          const url = normalizedDownloadURL(anchor.href);
          if (url) {
            links.add(url);
          }
        });
      }

      sendResponse({ links: Array.from(links) });
      return false;
    });
  }
})();
