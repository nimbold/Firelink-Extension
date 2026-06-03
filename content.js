// content.js
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
        if (a.href) {
          // ensure the link is a full URL by using the current document's base URI if it's relative
          try {
            const url = new URL(a.getAttribute('href'), document.baseURI).href;
            links.add(url);
          } catch (e) {
            // Invalid URL, fallback to just checking if it looks like a valid protocol
            if (a.href.startsWith("http")) {
              links.add(a.href);
            }
          }
        }
      });
    }

    sendResponse({ links: Array.from(links) });
  }
});
