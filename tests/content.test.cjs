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
