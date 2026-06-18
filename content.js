(() => {
  const allowedSchemes = new Set(["http:", "https:", "ftp:", "sftp:"]);
  const likelyDownloadExtensions = new Set([
    "7z", "apk", "appimage", "avi", "bin", "bz2", "dmg", "doc", "docx",
    "deb", "exe", "flac", "gz", "iso", "m4a", "m4v", "mkv", "mov", "mp3",
    "mp4", "msi", "pdf", "pkg", "ppt", "pptx", "rar", "rpm", "tar",
    "tgz", "torrent", "wav", "webm", "xls", "xlsx", "xz", "zip", "zst"
  ]);

  function normalizedDownloadURL(rawURL) {
    try {
      const url = new URL(rawURL, document.baseURI);
      return allowedSchemes.has(url.protocol) ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function extensionFromPath(pathname) {
    const match = pathname.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
    return match ? match[1] : "";
  }

  function isLikelyDownloadLink(anchor, url) {
    if (anchor.hasAttribute("download")) {
      return true;
    }

    const extension = extensionFromPath(url.pathname);
    if (likelyDownloadExtensions.has(extension)) {
      return true;
    }

    const rel = (anchor.getAttribute("rel") || "").toLowerCase();
    const type = (anchor.getAttribute("type") || "").toLowerCase();
    return rel.includes("download") || type.startsWith("application/");
  }

  function foregroundLeftClick(event) {
    return event.button === 0
      && !event.defaultPrevented
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey;
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

  if (!globalThis.firelinkClickInterceptorInstalled) {
    globalThis.firelinkClickInterceptorInstalled = true;
    document.addEventListener("click", event => {
      if (!foregroundLeftClick(event)) {
        return;
      }

      const anchor = event.target && event.target.closest
        ? event.target.closest("a[href]")
        : null;
      if (!anchor) {
        return;
      }

      const href = normalizedDownloadURL(anchor.href);
      if (!href) {
        return;
      }

      const url = new URL(href);
      if (!isLikelyDownloadLink(anchor, url)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      chrome.runtime.sendMessage(
        {
          action: "downloadWithFirelink",
          url: href,
          referer: window.location.href,
          filename: anchor.getAttribute("download") || undefined
        },
        response => {
          if (chrome.runtime.lastError || !response || !response.accepted) {
            window.location.assign(href);
          }
        }
      );
    }, true);
  }
})();
