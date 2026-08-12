(() => {
  const allowedSchemes = new Set(["http:", "https:", "ftp:", "sftp:", "magnet:"]);

  function normalizedDownloadURL(rawURL) {
    try {
      const url = new URL(rawURL, document.baseURI);
      return allowedSchemes.has(url.protocol) ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function normalizedAnchorURL(anchor) {
    const rawURL = typeof anchor?.getAttribute === "function"
      ? anchor.getAttribute("href")
      : anchor?.href;
    if (typeof rawURL !== "string" || rawURL.trim() === "") {
      return null;
    }
    return normalizedDownloadURL(rawURL);
  }

  function addIntersectingAnchors(range, anchors) {
    const addBoundaryAnchor = node => {
      let current = node?.nodeType === 1 ? node : node?.parentElement;
      while (current) {
        if (current.tagName?.toLowerCase() === "a") {
          anchors.add(current);
          break;
        }
        current = current.parentElement;
      }
    };

    addBoundaryAnchor(range.startContainer);
    addBoundaryAnchor(range.endContainer);

    const commonAncestor = range.commonAncestorContainer;
    if (commonAncestor?.nodeType === 1) {
      addBoundaryAnchor(commonAncestor);
      commonAncestor.querySelectorAll?.("a").forEach(anchor => {
        try {
          if (typeof range.intersectsNode !== "function" || range.intersectsNode(anchor)) {
            anchors.add(anchor);
          }
        } catch (error) {
          // A detached or otherwise invalid node should not prevent fallback
          // text extraction for the rest of the selection.
        }
      });
    }
  }

  if (!globalThis.firelinkSelectionLinkHandlerInstalled) {
    globalThis.firelinkSelectionLinkHandlerInstalled = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action !== "extractSelectionLinks") {
        return false;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        sendResponse({ links: [] });
        return false;
      }

      const links = new Set();
      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        const anchors = new Set(container.querySelectorAll("a"));
        // cloneContents() can omit the <a> wrapper when a selection starts
        // or ends inside an anchor. Include intersecting live anchors so
        // partial-anchor selections behave consistently in Firefox and
        // Chromium without scanning the whole document.
        addIntersectingAnchors(range, anchors);
        anchors.forEach(anchor => {
          const url = normalizedAnchorURL(anchor);
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
