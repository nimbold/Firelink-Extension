const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);

function createBackgroundContext(signedFetch) {
  const createdTabs = [];
  const createdNotifications = [];
  const notificationListeners = {};
  const noopEvent = { addListener() {} };
  const chrome = {
    contextMenus: {
      onClicked: noopEvent,
      create() {},
      removeAll(callback) { callback(); }
    },
    cookies: {
      getAll(_details, callback) { callback([]); }
    },
    downloads: {
      onCreated: noopEvent
    },
    notifications: {
      create(...args) { createdNotifications.push(args); },
      clear() {},
      onButtonClicked: {
        addListener(listener) { notificationListeners.button = listener; }
      },
      onClosed: {
        addListener(listener) { notificationListeners.closed = listener; }
      }
    },
    runtime: {
      lastError: null,
      onInstalled: noopEvent,
      onMessage: noopEvent
    },
    scripting: {
      executeScript() {}
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            globalCapture: true,
            siteToggles: {},
            extensionToken: "pairing-token"
          });
        },
        set() {}
      },
      onChanged: noopEvent
    },
    tabs: {
      create(details) { createdTabs.push(details); },
      sendMessage() {}
    }
  };
  const context = vm.createContext({
    AbortController,
    FirelinkProtocol: { signedFetch },
    Math,
    URL,
    chrome,
    console,
    navigator: { userAgent: "Firefox Test" },
    setTimeout
  });
  vm.runInContext(backgroundSource, context);
  return {
    context,
    createdNotifications,
    createdTabs,
    notificationListeners
  };
}

test("successful direct handoff does not open a protocol tab", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }));

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.createdNotifications.length, 0);
});

test("offline manual handoff offers explicit fallback before opening protocol URL", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: false };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.createdNotifications.length, 1);

  const [notificationId, options] = fixture.createdNotifications[0];
  assert.equal(options.buttons[0].title, "Use protocol fallback");

  fixture.notificationListeners.button(notificationId, 0);
  assert.equal(fixture.createdTabs.length, 1);
  assert.match(fixture.createdTabs[0].url, /^firelink:\/\/add\?/);
});

test("automatic capture failure never opens or offers protocol fallback", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: false };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"], "", { allowProtocolFallback: false, silent: true })',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.createdNotifications.length, 0);
});
