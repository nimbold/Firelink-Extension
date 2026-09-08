(() => {
  const allowedSchemes = new Set(["http:", "https:", "ftp:", "sftp:", "magnet:"]);
  const browserLocalTorrentSchemes = new Set(["blob:", "data:"]);
  const torrentMimeTypes = new Set([
    "application/bittorrent",
    "application/x-bittorrent",
    "application/x-torrent"
  ]);
  const maxTorrentBytes = 16 * 1024 * 1024;
  const localTorrentReadTimeoutMs = 10_000;
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

  function rawAnchorURL(anchor) {
    const rawURL = typeof anchor?.getAttribute === "function"
      ? anchor.getAttribute("href")
      : anchor?.href;
    return typeof rawURL === "string" && rawURL.trim() !== "" ? rawURL : null;
  }

  function torrentFilenameFromAnchor(anchor) {
    const value = typeof anchor?.getAttribute === "function"
      ? anchor.getAttribute("download")
      : anchor?.download;
    if (typeof value !== "string" || value.trim() === "") {
      return null;
    }
    const basename = value.trim().replace(/\\/g, "/").split("/").pop() || "";
    return basename.toLowerCase().endsWith(".torrent") ? value.trim() : null;
  }

  function isTorrentMime(value) {
    return typeof value === "string"
      && torrentMimeTypes.has(value.split(";", 1)[0].trim().toLowerCase());
  }

  function browserLocalTorrentDescriptor(anchor) {
    const rawURL = rawAnchorURL(anchor);
    if (!rawURL) {
      return null;
    }

    let url;
    try {
      url = new URL(rawURL, document.baseURI);
    } catch (error) {
      return null;
    }
    if (!browserLocalTorrentSchemes.has(url.protocol)) {
      return null;
    }

    const filename = torrentFilenameFromAnchor(anchor);
    const declaredMime = typeof anchor?.getAttribute === "function"
      ? anchor.getAttribute("type")
      : anchor?.type;
    const dataMime = url.protocol === "data:"
      ? url.pathname.split(",", 1)[0].split(";", 1)[0]
      : "";
    if (!filename && !isTorrentMime(declaredMime) && !isTorrentMime(dataMime)) {
      return null;
    }

    return {
      url: url.href,
      local: true,
      filename: filename || "download.torrent"
    };
  }

  function pageSourceURL() {
    const candidates = [
      document.location?.href,
      document.referrer,
      window.location?.href
    ];
    try {
      candidates.push(window.top?.location?.href);
    } catch (error) {
      // A cross-origin parent may expose no readable location to the frame.
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      try {
        const url = new URL(candidate, document.baseURI);
        if (["http:", "https:"].includes(url.protocol)) {
          return url.href;
        }
      } catch (error) {
        // Try the next frame/document URL.
      }
    }
    return undefined;
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

  function automaticTorrentDescriptor(anchor) {
    const url = normalizedAnchorURL(anchor);
    const filename = torrentFilenameFromAnchor(anchor);
    const isDownloadAttributeTorrent = Boolean(filename)
      && url
      && ["http:", "https:"].includes(new URL(url).protocol);
    if (url && (isAutomaticTorrentURL(url) || isDownloadAttributeTorrent)) {
      return {
        url,
        local: false,
        filename
      };
    }
    return browserLocalTorrentDescriptor(anchor);
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

  function anchorFromClickEvent(event) {
    for (const target of event?.composedPath?.() || []) {
      if (target?.tagName?.toLowerCase() === "a") {
        return target;
      }
    }
    return anchorFromEventTarget(event?.target);
  }

  function readResponseBytes(response) {
    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxTorrentBytes) {
      throw new Error("Torrent attachment is too large");
    }

    if (response?.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      return (async () => {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value instanceof Uint8Array
              ? next.value
              : new Uint8Array(next.value);
            total += chunk.byteLength;
            if (total > maxTorrentBytes) {
              await reader.cancel?.();
              throw new Error("Torrent attachment is too large");
            }
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock?.();
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      })();
    }

    return Promise.resolve(response.arrayBuffer()).then(buffer => {
      if (buffer.byteLength === 0 || buffer.byteLength > maxTorrentBytes) {
        throw new Error("Invalid torrent attachment size");
      }
      return new Uint8Array(buffer);
    });
  }

  async function readBrowserLocalTorrent(url) {
    const controller = typeof AbortController === "function"
      ? new AbortController()
      : null;
    let timeout = null;
    try {
      const fetchOptions = controller ? { signal: controller.signal } : undefined;
      const responsePromise = fetch(url, fetchOptions);
      const response = await Promise.race([
        responsePromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller?.abort();
            reject(new Error("Torrent attachment read timed out"));
          }, localTorrentReadTimeoutMs);
        })
      ]);
      if (response?.ok === false) {
        throw new Error("Could not read torrent attachment");
      }
      const bytes = await readResponseBytes(response);
      if (bytes.byteLength === 0) {
        throw new Error("Torrent attachment is empty");
      }

      // Use chunks whose size is divisible by three so independently encoded
      // pieces can be concatenated without introducing interior padding.
      const base64Chunks = [];
      const chunkSize = 49_152;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        let binary = "";
        for (let index = 0; index < chunk.length; index += 1) {
          binary += String.fromCharCode(chunk[index]);
        }
        base64Chunks.push(btoa(binary));
      }
      return base64Chunks.join("");
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
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
      const anchor = anchorFromClickEvent(event);
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

      const descriptor = automaticTorrentDescriptor(anchor);
      if (!descriptor) {
        return;
      }
      // Preserve the existing magnet behavior for links explicitly marked as
      // downloads, while direct .torrent downloads must still be captured.
      if (!descriptor.local
        && descriptor.url.toLowerCase().startsWith("magnet:")
        && anchor.hasAttribute?.("download")) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation?.();
      pendingAutomaticTorrentAnchors.add(anchor);
      const requestId = `${Date.now()}-${++automaticTorrentRequestSequence}`;
      const target = anchor.getAttribute?.("target");
      const openInNewTab = typeof target === "string"
        && target.trim().toLowerCase() === "_blank";
      const messageAction = automaticTorrentMessageAction(descriptor.url);
      const timeoutMessageAction = automaticTorrentTimeoutMessageAction(descriptor.url);
      let settled = false;
      let timeout = null;
      const replayOriginal = () => {
        if (settled) {
          return;
        }
        if (timeout !== null) clearTimeout(timeout);
        settled = true;
        pendingAutomaticTorrentAnchors.delete(anchor);
        replayAutomaticTorrentNavigation(anchor, descriptor.url);
      };
      const reportAmbiguousCapture = () => {
        if (settled) {
          return;
        }
        if (timeout !== null) clearTimeout(timeout);
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
        if (timeout !== null) clearTimeout(timeout);
        settled = true;
        pendingAutomaticTorrentAnchors.delete(anchor);
        if (response?.intercepted !== true) {
          replayAutomaticTorrentNavigation(anchor, descriptor.url);
        }
      };

      const sendCaptureMessage = message => {
        if (settled) return;
        timeout = setTimeout(reportAmbiguousCapture, automaticTorrentHandoffTimeoutMs);
        try {
          const result = chrome.runtime.sendMessage(
            message,
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
          replayOriginal();
        }
      };

      if (descriptor.local) {
        void readBrowserLocalTorrent(descriptor.url).then(
          torrentBytesBase64 => sendCaptureMessage({
            action: messageAction,
            requestId,
            url: descriptor.url.length <= 4096 ? descriptor.url : undefined,
            sourceURL: pageSourceURL(),
            openInNewTab,
            browserLocalTorrent: true,
            filename: descriptor.filename,
            torrentBytesBase64
          }),
          () => replayOriginal()
        );
      } else {
        sendCaptureMessage({
          action: messageAction,
          requestId,
          url: descriptor.url,
          openInNewTab,
          ...(descriptor.filename ? { filename: descriptor.filename } : {})
        });
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
