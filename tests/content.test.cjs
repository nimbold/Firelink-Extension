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
