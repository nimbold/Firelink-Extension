const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);

function createBackgroundContext(signedFetch, options = {}) {
  const createdTabs = [];
  const createdNotifications = [];
  const cookieQueries = [];
  const downloadActions = [];
  const removedTabs = [];
  const storageWrites = [];
  const listeners = {};
  const noopEvent = { addListener() {} };
  const chrome = {
    contextMenus: {
      onClicked: {
        addListener(listener) { listeners.contextMenu = listener; }
      },
      create() {},
      removeAll(callback) { callback(); }
    },
    cookies: {
      getAll(details, callback) {
        cookieQueries.push(details);
        callback(options.cookiesByUrl?.[details.url] || []);
      }
    },
    downloads: {
      onCreated: {
        addListener(listener) { listeners.downloadCreated = listener; }
      },
      pause(id, callback) {
        downloadActions.push(["pause", id]);
        callback();
      },
      resume(id, callback) {
        downloadActions.push(["resume", id]);
        callback();
      },
      cancel(id, callback) {
        downloadActions.push(["cancel", id]);
        callback();
      },
      erase(query, callback) {
        downloadActions.push(["erase", query]);
        callback();
      }
    },
    notifications: {
      create(...args) { createdNotifications.push(args); }
    },
    runtime: {
      lastError: null,
      onInstalled: noopEvent
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
            extensionToken: "pairing-token",
            ...options.settings
          });
        },
        set(value) { storageWrites.push(value); }
      },
      onChanged: noopEvent
    },
    tabs: {
      create(details, callback) {
        createdTabs.push(details);
        const complete = () => {
          chrome.runtime.lastError = options.protocolError
            ? { message: options.protocolError }
            : null;
          callback?.({ id: createdTabs.length });
          chrome.runtime.lastError = null;
        };
        if (options.deferTabCreate) {
          Promise.resolve().then(complete);
        } else {
          complete();
        }
      },
      remove(id, callback) {
        removedTabs.push(id);
        callback?.();
      },
      sendMessage() {}
    }
  };
  const context = vm.createContext({
    AbortController,
    FirelinkProtocol: { signedFetch },
    URL,
    chrome,
    console,
    navigator: { userAgent: "Firefox Test" },
    setTimeout: options.setTimeout || setTimeout,
    Date: options.Date || Date
  });
  vm.runInContext(backgroundSource, context);
  return {
    context,
    createdNotifications,
    createdTabs,
    removedTabs,
    storageWrites,
    cookieQueries,
    downloadActions,
    listeners
  };
}

test("starts without unsupported Firefox notification button APIs", () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }));
  assert.equal(typeof fixture.listeners.contextMenu, "function");
  assert.equal(typeof fixture.listeners.downloadCreated, "function");
});

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

test("offline manual handoff launches then delivers original payload", async () => {
  const calls = [];
  const fixture = createBackgroundContext(async (path, _token, request) => {
    calls.push({ path, request });
    if (calls.length === 1) {
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }
    return { ok: true };
  }, {
    cookiesByUrl: {
      "https://example.com/file.zip": [{ name: "session", value: "private" }]
    }
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"], "https://example.com/page", { filename: "file.zip" })',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(fixture.createdTabs.length, 1);
  assert.equal(fixture.createdTabs[0].url, "firelink://launch");
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(calls[1].path, "/ping");
  assert.equal(calls[2].path, "/download");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].request.payload)), {
    urls: ["https://example.com/file.zip"],
    referer: "https://example.com/page",
    silent: false,
    filename: "file.zip",
    headers: "User-Agent: Firefox Test",
    cookies: "session=private"
  });
  assert.equal(fixture.createdNotifications.length, 0);
});

test("reports a missing Firelink protocol registration", async () => {
  const fixture = createBackgroundContext(
    async () => {
      throw { serverReached: false, requestMayHaveBeenSent: false };
    },
    { protocolError: "Unknown protocol" }
  );

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdNotifications.length, 1);
  assert.equal(
    fixture.createdNotifications[0][0].title,
    "Firelink Was Not Opened"
  );
});

test("creating launch tab is not success when authenticated discovery times out", async () => {
  let now = 0;
  const fixture = createBackgroundContext(
    async () => {
      throw { serverReached: false, requestMayHaveBeenSent: false };
    },
    {
      Date: { now: () => (now += 1000) },
      setTimeout: callback => {
        callback();
        return 1;
      }
    }
  );

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdTabs[0].url, "firelink://launch");
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(fixture.createdNotifications.at(-1)[0].title, "Firelink Was Not Opened");
});

test("ambiguous POST failure never launches or resends", async () => {
  let calls = 0;
  const fixture = createBackgroundContext(async () => {
    calls += 1;
    throw {
      serverReached: false,
      requestMayHaveBeenSent: true
    };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(calls, 1);
  assert.equal(fixture.createdTabs.length, 0);
});

test("invalid pairing response never opens protocol tab", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: true, status: 403 };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.createdNotifications[0][0].title, "Firelink Connection Rejected");
});

test("server errors never trigger protocol fallback", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: true, status: 500 };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdTabs.length, 0);
});

test("manual startup retries known non-delivery 503 without opening protocol", async () => {
  let calls = 0;
  const fixture = createBackgroundContext(async () => {
    calls += 1;
    if (calls < 3) {
      throw { serverReached: true, status: 503 };
    }
    return { ok: true };
  }, {
    setTimeout: callback => {
      callback();
      return 1;
    }
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(calls, 3);
  assert.equal(fixture.createdTabs.length, 0);
});

test("concurrent manual actions share one launch and deliver each payload once", async () => {
  const delivered = [];
  let initialFailures = 0;
  const fixture = createBackgroundContext(async (path, _token, request) => {
    if (path === "/download" && initialFailures < 2) {
      initialFailures += 1;
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }
    if (path === "/download") {
      delivered.push(request.payload.urls[0]);
    }
    return { ok: true };
  }, { deferTabCreate: true });

  const accepted = await vm.runInContext(
    'Promise.all([' +
      'sendToFirelink(["https://example.com/one.zip"]),' +
      'sendToFirelink(["https://example.com/two.zip"])' +
    '])',
    fixture.context
  );

  assert.deepEqual(Array.from(accepted), [true, true]);
  assert.equal(fixture.createdTabs.length, 1);
  assert.deepEqual(delivered.sort(), [
    "https://example.com/one.zip",
    "https://example.com/two.zip"
  ]);
  assert.deepEqual(fixture.removedTabs, [1]);
});

test("automatic capture failure resumes the browser download without fallback", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: false };
  });

  await fixture.listeners.downloadCreated({
    id: 42,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(fixture.downloadActions, [
    ["pause", 42],
    ["resume", 42]
  ]);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.createdNotifications.length, 0);
});

test("automatic capture marks the payload silent but still confirms success", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 7,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(payload.silent, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 7],
    ["cancel", 7],
    ["erase", { id: 7 }]
  ]);
  assert.equal(fixture.createdNotifications.length, 1);
});

test("never shares first-party cookies across a multi-host batch", async () => {
  let payload = null;
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      return { ok: true };
    },
    {
      cookiesByUrl: {
        "https://one.example/a.zip": [
          { name: "session", value: "private" }
        ]
      }
    }
  );

  await vm.runInContext(
    'sendToFirelink(["https://one.example/a.zip", "https://two.example/b.zip"])',
    fixture.context
  );

  assert.equal(payload.headers, "User-Agent: Firefox Test");
  assert.equal(payload.cookies, undefined);
});

test("passes single-download cookies through the dedicated cookie field", async () => {
  let payload = null;
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      return { ok: true };
    },
    {
      cookiesByUrl: {
        "https://one.example/a.zip": [
          { name: "session", value: "private" },
          { name: "locale", value: "en" }
        ]
      }
    }
  );

  await vm.runInContext(
    'sendToFirelink(["https://one.example/a.zip"], "", { cookieStoreId: "firefox-container-2" })',
    fixture.context
  );

  assert.equal(payload.cookies, "session=private; locale=en");
  assert.doesNotMatch(payload.headers, /Cookie:/);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), [{
    url: "https://one.example/a.zip",
    storeId: "firefox-container-2"
  }]);
});
