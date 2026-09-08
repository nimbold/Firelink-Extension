(() => {
  const allowedSchemes = new Set(["http:", "https:", "ftp:", "sftp:", "magnet:"]);
  const maxSelectionLinks = 200;
  const automaticTorrentHandoffTimeoutMs = 25_000;
  let automaticTorrentRequestSequence = 0;
  const replayedAutomaticTorrentAnchors = new WeakSet();
  const pendingAutomaticTorrentAnchors = new WeakSet();

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

  function isDirectTorrentURL(rawURL) {
    try {
      const url = new URL(rawURL);
      return ["http:", "https:"].includes(url.protocol)
        && url.pathname.toLowerCase().endsWith(".torrent");
    } catch (error) {
      return false;
    }
  }

  function isAutomaticTorrentURL(url) {
    return url?.toLowerCase().startsWith("magnet:") || isDirectTorrentURL(url);
  }

  function automaticTorrentMessageAction(url) {
    return url.toLowerCase().startsWith("magnet:")
      ? "captureAutomaticMagnet"
      : "captureAutomaticTorrent";
  }

  function automaticTorrentTimeoutMessageAction(url) {
    return url.toLowerCase().startsWith("magnet:")
      ? "reportAutomaticMagnetTimeout"
      : "reportAutomaticTorrentTimeout";
  }

  function isDefiniteAutomaticTorrentDeliveryFailure(error) {
    const message = typeof error === "string" ? error : error?.message;
    return typeof message === "string"
      && /receiving end does not exist/i.test(message);
  }

  function anchorFromEventTarget(target) {
    let current = target?.nodeType === 1 ? target : target?.parentElement;
    while (current && current !== document) {
      if (current.tagName?.toLowerCase() === "a") {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function replayAutomaticTorrentNavigation(anchor, url) {
    try {
      if (anchor && anchor.isConnected !== false && typeof anchor.click === "function") {
        replayedAutomaticTorrentAnchors.add(anchor);
        anchor.click();
        return;
      }
      if (typeof window.location?.assign === "function") {
        window.location.assign(url);
      } else {
        window.location.href = url;
      }
    } catch (error) {
      try {
        window.location.href = url;
      } catch (ignored) {
        // The page may have gone away while the background handoff failed.
      }
    }
  }

  function installAutomaticTorrentClickHandler() {
    if (typeof document.addEventListener !== "function"
      || globalThis.firelinkAutomaticTorrentClickHandlerInstalled) {
      return;
    }
    globalThis.firelinkAutomaticTorrentClickHandlerInstalled = true;

    document.addEventListener("click", event => {
      const anchor = anchorFromEventTarget(event.target);
      if (!anchor || replayedAutomaticTorrentAnchors.has(anchor)) {
        replayedAutomaticTorrentAnchors.delete(anchor);
        return;
      }
      if (pendingAutomaticTorrentAnchors.has(anchor)) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        return;
      }
      if (event.defaultPrevented
        || event.isTrusted === false
        || (event.button !== undefined && event.button !== 0)
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey) {
        return;
      }

      const url = normalizedAnchorURL(anchor);
      if (!url || !isAutomaticTorrentURL(url)) {
        return;
      }
      // Preserve the existing magnet behavior for links explicitly marked as
      // downloads, while direct .torrent downloads must still be captured.
      if (url.toLowerCase().startsWith("magnet:") && anchor.hasAttribute?.("download")) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation?.();
      pendingAutomaticTorrentAnchors.add(anchor);
      const requestId = `${Date.now()}-${++automaticTorrentRequestSequence}`;
      const target = anchor.getAttribute?.("target");
      const openInNewTab = typeof target === "string"
        && target.trim().toLowerCase() === "_blank";
      const messageAction = automaticTorrentMessageAction(url);
      const timeoutMessageAction = automaticTorrentTimeoutMessageAction(url);
      let settled = false;
      const replayOriginal = () => {
        if (settled) {
          return;
        }
        clearTimeout(timeout);
        settled = true;
        pendingAutomaticTorrentAnchors.delete(anchor);
        replayAutomaticTorrentNavigation(anchor, url);
      };
      const reportAmbiguousCapture = () => {
        if (settled) {
          return;
        }
        clearTimeout(timeout);
        settled = true;
        pendingAutomaticTorrentAnchors.delete(anchor);
        try {
          const result = chrome.runtime.sendMessage({
            action: timeoutMessageAction,
            requestId
          });
          result?.catch?.(() => {});
        } catch (error) {
          // The page may have gone away while the ambiguous handoff was being
          // reported; suppressing a possible duplicate remains the safe path.
        }
      };
      const completeCapture = (response, error = null) => {
        if (settled) {
          return;
        }
        if (error) {
          if (isDefiniteAutomaticTorrentDeliveryFailure(error)) {
            replayOriginal();
          } else {
            reportAmbiguousCapture();
          }
          return;
        }
        if (response?.ambiguous === true) {
          // The background already classified and reported this response as
          // ambiguous. Suppress the original navigation without sending a
          // second timeout report.
          clearTimeout(timeout);
          settled = true;
          pendingAutomaticTorrentAnchors.delete(anchor);
          return;
        }
        clearTimeout(timeout);
        settled = true;
        pendingAutomaticTorrentAnchors.delete(anchor);
        if (response?.intercepted !== true) {
          replayAutomaticTorrentNavigation(anchor, url);
        }
      };
      const timeout = setTimeout(
        reportAmbiguousCapture,
        automaticTorrentHandoffTimeoutMs
      );

      try {
        const result = chrome.runtime.sendMessage(
          { action: messageAction, requestId, url, openInNewTab },
          response => {
            completeCapture(response, chrome.runtime?.lastError || null);
          }
        );
        if (result && typeof result.then === "function") {
          result.then(
            response => completeCapture(response),
            error => completeCapture(null, error)
          );
        }
      } catch (error) {
        clearTimeout(timeout);
        replayOriginal();
      }
    }, true);
  }

  installAutomaticTorrentClickHandler();

  function addAnchor(anchors, anchor) {
    if (anchor && anchors.size < maxSelectionLinks) {
      anchors.add(anchor);
    }
  }

  function walkAnchors(root, visit) {
    if (!root) return;
    if (typeof document.createTreeWalker === "function") {
      const walker = document.createTreeWalker(root, 1);
      let current = walker.nextNode();
      while (current) {
        if (current.tagName?.toLowerCase() === "a") {
          if (visit(current) === false) {
            break;
          }
        }
        current = walker.nextNode();
      }
      return;
    }
    for (const anchor of root.querySelectorAll?.("a") || []) {
      if (visit(anchor) === false) {
        break;
      }
    }
  }

  function addIntersectingAnchors(range, anchors) {
    const addBoundaryAnchor = node => {
      let current = node?.nodeType === 1 ? node : node?.parentElement;
      while (current) {
        if (current.tagName?.toLowerCase() === "a") {
          addAnchor(anchors, current);
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
      walkAnchors(commonAncestor, anchor => {
        if (anchors.size >= maxSelectionLinks) return false;
        try {
          if (typeof range.intersectsNode !== "function" || range.intersectsNode(anchor)) {
            addAnchor(anchors, anchor);
          }
        } catch (error) {
          // A detached or otherwise invalid node should not prevent fallback
          // text extraction for the rest of the selection.
        }
        return anchors.size < maxSelectionLinks;
      });
    }
  }

  if (!globalThis.firelinkSelectionLinkHandlerInstalled) {
    globalThis.firelinkSelectionLinkHandlerInstalled = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request?.action !== "extractSelectionLinks") {
        return false;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        sendResponse({ links: [] });
        return false;
      }

      try {
        const links = new Set();
        for (let i = 0; i < selection.rangeCount && links.size < maxSelectionLinks; i += 1) {
          const range = selection.getRangeAt(i);
          const container = document.createElement("div");
          container.appendChild(range.cloneContents());
          const anchors = new Set();
          walkAnchors(container, anchor => {
            addAnchor(anchors, anchor);
            return anchors.size < maxSelectionLinks;
          });
          // cloneContents() can omit the <a> wrapper when a selection starts
          // or ends inside an anchor. Include intersecting live anchors so
          // partial-anchor selections behave consistently in Firefox and
          // Chromium without scanning the whole document.
          addIntersectingAnchors(range, anchors);
          for (const anchor of anchors) {
            if (links.size >= maxSelectionLinks) {
              break;
            }
            const url = normalizedAnchorURL(anchor);
            if (url) {
              links.add(url);
            }
          }
        }

        sendResponse({ links: Array.from(links) });
      } catch (error) {
        sendResponse({ links: [] });
      }
      return false;
    });
  }
})();
