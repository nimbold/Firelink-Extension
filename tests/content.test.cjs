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
