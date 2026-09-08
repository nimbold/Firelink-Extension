const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const contentSource = fs.readFileSync(
  require("node:path").join(__dirname, "..", "content.js"),
  "utf8"
);

test("content link extraction accepts magnet links", () => {
  let listener;
  const context = vm.createContext({
    URL,
    document: { baseURI: "https://example.com/page" },
    window: {
      getSelection() {
        return {
          rangeCount: 1,
          getRangeAt() {
            const container = {
              querySelectorAll() {
                return [
                  { href: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" },
                  { href: "javascript:alert(1)" }
                ];
              }
            };
            return { cloneContents: () => container };
          }
        };
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) { listener = value; }
        }
      }
    }
  });
  context.document.createElement = () => ({
    appendChild() {},
    querySelectorAll: context.window.getSelection().getRangeAt().cloneContents().querySelectorAll
  });

  vm.runInContext(contentSource, context);
  let response;
  listener({ action: "extractSelectionLinks" }, {}, value => { response = value; });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    links: ["magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"]
  });
});

test("intercepts a primary magnet click until Firelink accepts it", () => {
  let clickListener;
  let sentMessage;
  let prevented = false;
  let stopped = false;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href"
        ? "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        : null;
    },
    hasAttribute() { return false; },
    click() { throw new Error("original navigation should not run after acceptance"); }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message, callback) {
          sentMessage = message;
          callback({ intercepted: true });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; }
  });

  assert.equal(sentMessage.action, "captureAutomaticMagnet");
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("replays the original magnet click when the background declines capture", () => {
  let clickListener;
  let replayed = 0;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href"
        ? "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(_message, callback) {
          callback({ intercepted: false });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(replayed, 1);
});

test("replays a magnet when no background listener received the message", () => {
  let clickListener;
  let replayed = 0;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href"
        ? "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(_message, callback) {
          context.chrome.runtime.lastError = {
            message: "Could not establish connection. Receiving end does not exist."
          };
          callback();
          context.chrome.runtime.lastError = null;
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(replayed, 1);
});

test("does not replay a magnet when the handoff result is ambiguous", () => {
  let clickListener;
  let timeoutCallback;
  let replayed = 0;
  const sentMessages = [];
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href"
        ? "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message) {
          sentMessages.push(message);
        }
      }
    },
    setTimeout(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout() {}
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  timeoutCallback();

  assert.equal(replayed, 0);
  assert.equal(sentMessages.at(-1).action, "reportAutomaticMagnetTimeout");
});

test("intercepts a direct torrent click including query, case, and download attributes", () => {
  let clickListener;
  let sentMessage;
  let prevented = false;
  let stopped = false;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href"
        ? "https://example.com/files/Release.TORRENT?mirror=1#download"
        : null;
    },
    hasAttribute(name) { return name === "download"; },
    click() { throw new Error("original navigation should not run after acceptance"); }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message) {
          sentMessage = message;
          return Promise.resolve({ intercepted: true, ambiguous: false });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; }
  });

  assert.equal(sentMessage.action, "captureAutomaticTorrent");
  assert.equal(sentMessage.url, "https://example.com/files/Release.TORRENT?mirror=1#download");
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("intercepts an opaque HTTP torrent download identified by its download attribute", () => {
  let clickListener;
  let sentMessage;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      if (name === "href") return "https://example.com/download?id=attachment";
      if (name === "download") return "TerraScape.torrent";
      return null;
    },
    hasAttribute(name) { return name === "download"; },
    click() { throw new Error("original navigation should not run after acceptance"); }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message, callback) {
          sentMessage = message;
          callback({ intercepted: true, ambiguous: false });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(sentMessage.action, "captureAutomaticTorrent");
  assert.equal(sentMessage.url, "https://example.com/download?id=attachment");
  assert.equal(sentMessage.filename, "TerraScape.torrent");
});

test("intercepts a browser-local torrent attachment and sends its bytes", async () => {
  let clickListener;
  let sentMessage;
  let prevented = false;
  let stopped = false;
  const bytes = Uint8Array.from([100, 52, 58, 105, 110, 102, 111, 101]);
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      if (name === "href") return "blob:https://example.com/attachment-id";
      if (name === "download") return "TerraScape [FitGirl Repack].torrent";
      return null;
    },
    hasAttribute(name) { return name === "download"; },
    click() { throw new Error("original navigation should not run after acceptance"); }
  };
  const context = vm.createContext({
    URL,
    Date,
    Promise,
    Uint8Array,
    AbortController,
    btoa,
    fetch(url, options) {
      assert.equal(url, "blob:https://example.com/attachment-id");
      assert.ok(options?.signal);
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => bytes.buffer
      });
    },
    document: {
      baseURI: "blob:https://example.com/page-id",
      location: { href: "blob:https://example.com/page-id" },
      referrer: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { href: "blob:https://example.com/page-id", assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message, callback) {
          sentMessage = message;
          callback({ intercepted: true, ambiguous: false });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sentMessage.action, "captureAutomaticTorrent");
  assert.equal(sentMessage.browserLocalTorrent, true);
  assert.equal(sentMessage.url, "blob:https://example.com/attachment-id");
  assert.equal(sentMessage.sourceURL, "https://example.com/page");
  assert.equal(sentMessage.filename, "TerraScape [FitGirl Repack].torrent");
  assert.equal(sentMessage.torrentBytesBase64, Buffer.from(bytes).toString("base64"));
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("recognizes a data torrent MIME URL and replays when the local read fails", async () => {
  let clickListener;
  let replayed = 0;
  let sent = false;
  let fetchCalled = false;
  let prevented = false;
  const context = vm.createContext({
    URL,
    Promise,
    Uint8Array,
    AbortController,
    btoa,
    fetch() {
      fetchCalled = true;
      return Promise.reject(new Error("attachment disappeared"));
    },
    document: {
      baseURI: "https://example.com/page",
      location: { href: "https://example.com/page" },
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { href: "https://example.com/page", assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage() { sent = true; }
      }
    },
    setTimeout,
    clearTimeout
  });
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href" ? "data:application/x-bittorrent;base64,ZA==" : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sent, false);
  assert.equal(fetchCalled, true);
  assert.equal(prevented, true);
  assert.equal(replayed, 1);
});

test("replays a direct torrent click when automatic capture declines it", () => {
  let clickListener;
  let replayed = 0;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href" ? "https://example.com/sample.torrent" : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(_message, callback) {
          callback({ intercepted: false, ambiguous: false });
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(replayed, 1);
});

test("replays a direct torrent click when the receiver is definitely unavailable", () => {
  let clickListener;
  let replayed = 0;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href" ? "https://example.com/sample.torrent" : null;
    },
    hasAttribute() { return true; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(_message, callback) {
          context.chrome.runtime.lastError = {
            message: "Could not establish connection. Receiving end does not exist."
          };
          callback();
          context.chrome.runtime.lastError = null;
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(replayed, 1);
});

test("does not replay a direct torrent click when the handoff is ambiguous", () => {
  let clickListener;
  let timeoutCallback;
  let replayed = 0;
  const sentMessages = [];
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href" ? "https://example.com/sample.torrent" : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        lastError: null,
        sendMessage(message) {
          sentMessages.push(message);
        }
      }
    },
    setTimeout(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout() {}
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  timeoutCallback();

  assert.equal(replayed, 0);
  assert.equal(sentMessages.at(-1).action, "reportAutomaticTorrentTimeout");
});

test("does not report an ambiguity twice when the background already classified it", () => {
  let clickListener;
  const sentMessages = [];
  let replayed = 0;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    isConnected: true,
    getAttribute(name) {
      return name === "href" ? "https://example.com/sample.torrent" : null;
    },
    hasAttribute() { return false; },
    click() { replayed += 1; }
  };
  const context = vm.createContext({
    URL,
    Date,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() { return { rangeCount: 0 }; },
      location: { assign() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sentMessages.push(message);
          if (callback) {
            callback({ intercepted: true, ambiguous: true });
          }
        }
      }
    },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    isTrusted: true,
    preventDefault() {},
    stopImmediatePropagation() {}
  });

  assert.equal(replayed, 0);
  assert.deepEqual(sentMessages.map(message => message.action), ["captureAutomaticTorrent"]);
});

test("preserves modified-click behavior for direct torrent links", () => {
  let clickListener;
  let sent = false;
  let prevented = false;
  const anchor = {
    nodeType: 1,
    tagName: "A",
    getAttribute(name) {
      return name === "href" ? "https://example.com/sample.torrent" : null;
    },
    hasAttribute() { return false; }
  };
  const context = vm.createContext({
    URL,
    document: {
      baseURI: "https://example.com/page",
      addEventListener(type, listener) {
        if (type === "click") clickListener = listener;
      },
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: { getSelection() { return { rangeCount: 0 }; } },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { sent = true; }
      }
    }
  });

  vm.runInContext(contentSource, context);
  clickListener({
    target: anchor,
    button: 0,
    ctrlKey: true,
    isTrusted: true,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() {}
  });

  assert.equal(sent, false);
  assert.equal(prevented, false);
});

test("content link extraction includes an anchor intersected by a partial selection", () => {
  let listener;
  const anchor = {
    href: "https://example.com/partial.zip",
    nodeType: 1,
    tagName: "A",
    parentElement: null,
    getAttribute(name) { return name === "href" ? this.href : null; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    URL,
    document: {
      baseURI: "https://example.com/page",
      createElement() {
        return {
          appendChild() {},
          querySelectorAll() { return []; }
        };
      },
    },
    window: {
      getSelection() {
        return {
          rangeCount: 1,
          getRangeAt() {
            return {
              cloneContents: () => ({}),
              startContainer: anchor,
              endContainer: anchor,
              commonAncestorContainer: anchor,
              intersectsNode(node) { return node === anchor; }
            };
          }
        };
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) { listener = value; }
        }
      }
    }
  });

  vm.runInContext(contentSource, context);
  let response;
  listener({ action: "extractSelectionLinks" }, {}, value => { response = value; });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    links: ["https://example.com/partial.zip"]
  });
});

test("content link extraction ignores a collapsed caret inside an anchor", () => {
  let listener;
  const context = vm.createContext({
    URL,
    document: {
      baseURI: "https://example.com/page",
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() {
        return { rangeCount: 1, isCollapsed: true, getRangeAt() { return {}; } };
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) { listener = value; }
        }
      }
    }
  });

  vm.runInContext(contentSource, context);
  let response;
  listener({ action: "extractSelectionLinks" }, {}, value => { response = value; });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { links: [] });
});

test("content link extraction ignores anchors without href attributes", () => {
  let listener;
  const anchor = {
    href: "https://example.com/page",
    nodeType: 1,
    tagName: "A",
    getAttribute() { return null; },
    parentElement: null,
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    URL,
    document: {
      baseURI: "https://example.com/page",
      createElement() {
        return { appendChild() {}, querySelectorAll() { return []; } };
      }
    },
    window: {
      getSelection() {
        return {
          rangeCount: 1,
          isCollapsed: false,
          getRangeAt() {
            return {
              cloneContents: () => ({ querySelectorAll() { return [anchor]; } }),
              startContainer: anchor,
              endContainer: anchor,
              commonAncestorContainer: anchor,
              intersectsNode(node) { return node === anchor; }
            };
          }
        };
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) { listener = value; }
        }
      }
    }
  });

  vm.runInContext(contentSource, context);
  let response;
  listener({ action: "extractSelectionLinks" }, {}, value => { response = value; });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { links: [] });
});
