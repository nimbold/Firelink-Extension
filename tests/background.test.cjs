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
  const alarmsCreated = [];
  const contextMenuItems = [];
  const executedScripts = [];
  const sentMessages = [];
  const listeners = {};
  const deferredStorageCallbacks = [];
  let deferredStorageGetCount = 0;
  const noopEvent = { addListener() {} };
  const chrome = {
    contextMenus: {
      onClicked: {
        addListener(listener) { listeners.contextMenu = listener; }
      },
      create(item) { contextMenuItems.push(item); },
      removeAll(callback) { callback(); }
    },
    cookies: {
      getAll(details, callback) {
        cookieQueries.push(details);
        callback(options.cookiesByUrl?.[details.url] || []);
      },
      getAllCookieStores(callback) {
        callback(options.cookieStores || []);
      }
    },
    downloads: {
      onCreated: {
        addListener(listener) { listeners.downloadCreated = listener; }
      },
      onChanged: {
        addListener(listener) { listeners.downloadChanged = listener; }
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
      },
      search(query, callback) {
        const item = options.downloadsById?.[query.id];
        callback(item ? [item] : []);
      }
    },
    alarms: {
      onAlarm: {
        addListener(listener) { listeners.alarm = listener; }
      },
      create(name, alarmInfo) {
        alarmsCreated.push([name, alarmInfo]);
      },
      clear() {
        return Promise.resolve(true);
      }
    },
    notifications: {
      create(...args) { createdNotifications.push(args); }
    },
    runtime: {
      lastError: null,
      onInstalled: noopEvent,
      onMessage: {
        addListener(listener) { listeners.message = listener; }
      }
    },
    scripting: {
      executeScript(details, callback) {
        executedScripts.push(details);
        chrome.runtime.lastError = options.scriptInjectionError
          ? { message: options.scriptInjectionError }
          : null;
        callback?.();
        chrome.runtime.lastError = null;
      }
    },
    storage: {
      local: {
        get(_keys, callback) {
          const result = {
            globalCapture: true,
            siteToggles: {},
            extensionToken: "pairing-token",
            ...(options.pendingCaptures
              ? { pendingAutomaticCaptures: options.pendingCaptures }
              : {}),
            ...options.settings
          };
          if (options.deferStorageGet && (
            !options.deferStorageGetOnce || deferredStorageGetCount++ === 0
          )) {
            deferredStorageCallbacks.push(() => callback(result));
            options.deferStorageGet(() => {
              const callbacks = deferredStorageCallbacks.splice(0);
              callbacks.forEach(release => release());
            });
          } else if (Object.prototype.hasOwnProperty.call(options, "storageGetResult")) {
            callback(options.storageGetResult);
          } else {
            callback(result);
          }
        },
        set(value, callback) {
          storageWrites.push(value);
          callback?.();
        }
      },
      onChanged: noopEvent
    },
    tabs: {
      query(_queryInfo, callback) {
        callback(options.activeTabs || []);
      },
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
        if (options.deferTabRemove) {
          options.deferTabRemove(() => callback?.());
        } else {
          callback?.();
        }
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        chrome.runtime.lastError = options.sendMessageError
          ? { message: options.sendMessageError }
          : null;
        callback?.(options.selectionResponse || { links: [] });
        chrome.runtime.lastError = null;
      }
    }
  };
  if (options.omitCookiesApi) {
    delete chrome.cookies;
  }
  const context = vm.createContext({
    AbortController,
    FirelinkProtocol: { signedFetch },
    URL,
    chrome,
    console,
    navigator: { userAgent: "Firefox Test" },
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Date: options.Date || Date
  });
  vm.runInContext(backgroundSource, context);
  return {
    context,
    createdNotifications,
    createdTabs,
    removedTabs,
    storageWrites,
    alarmsCreated,
    cookieQueries,
    downloadActions,
    contextMenuItems,
    executedScripts,
    sentMessages,
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
  assert.equal(fixture.createdTabs[0].active, true);
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(calls[1].path, "/ping");
  assert.equal(calls[2].path, "/download");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].request.payload)), {
    urls: ["https://example.com/file.zip"],
    referer: "https://example.com/page",
    silent: false,
    filename: "file.zip",
    headers: "User-Agent: Firefox Test",
    media: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), []);
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
  assert.equal(fixture.createdTabs[0].active, true);
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
  assert.equal(fixture.createdTabs[0].active, true);
  assert.deepEqual(delivered.sort(), [
    "https://example.com/one.zip",
    "https://example.com/two.zip"
  ]);
  assert.deepEqual(fixture.removedTabs, [1]);
});

test("launch cleanup serializes a new handoff until the old tab is closed", async () => {
  let downloadCalls = 0;
  const tabCloseReleases = [];
  const fixture = createBackgroundContext(async path => {
    if (path === "/download") {
      downloadCalls += 1;
    }
    if (path === "/download" && (downloadCalls === 1 || downloadCalls === 3)) {
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }
    return { ok: true };
  }, {
    deferTabRemove(release) {
      tabCloseReleases.push(release);
    }
  });

  const firstPromise = vm.runInContext(
    'sendToFirelink(["https://example.com/one.zip"])',
    fixture.context
  );
  while (tabCloseReleases.length === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const secondPromise = vm.runInContext(
    'sendToFirelink(["https://example.com/two.zip"])',
    fixture.context
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.createdTabs.length, 1);

  tabCloseReleases.shift()();
  while (tabCloseReleases.length === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  tabCloseReleases.shift()();
  assert.equal(await firstPromise, true);
  assert.equal(await secondPromise, true);
  assert.deepEqual(fixture.createdTabs.map(tab => tab.url), [
    "firelink://launch",
    "firelink://launch"
  ]);
  assert.deepEqual(fixture.removedTabs, [1, 2]);
});

test("queued launch deliveries keep their own startup deadline", async () => {
  let now = 0;
  let downloadCalls = 0;
  let secondPromise;
  const fixture = createBackgroundContext(async path => {
    if (path === "/ping") {
      return { ok: true };
    }

    downloadCalls += 1;
    if (downloadCalls === 1) {
      now = 14000;
      secondPromise = vm.runInContext(
        'enqueueLaunchDelivery("pairing-token", { urls: ["https://example.com/two.zip"] })',
        fixture.context
      );
      now = 16000;
    }
    return { ok: true };
  }, {
    Date: { now: () => now }
  });

  const firstPromise = vm.runInContext(
    'enqueueLaunchDelivery("pairing-token", { urls: ["https://example.com/one.zip"] })',
    fixture.context
  );
  const firstResult = await firstPromise;
  const secondResult = await secondPromise;

  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(downloadCalls, 2);
});

test("automatic capture launches Firelink when the desktop app is closed", async () => {
  let directDownloadAttempts = 0;
  let deliveredPayload = null;
  let deliveredProtocolVersion = null;
  const fixture = createBackgroundContext(async (path, _token, request) => {
    if (path === "/download" && directDownloadAttempts === 0) {
      directDownloadAttempts += 1;
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }

    if (path === "/download") {
      deliveredPayload = request.payload;
      deliveredProtocolVersion = request.requiredProtocolVersion;
    }

    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 42,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 42],
    ["cancel", 42],
    ["erase", { id: 42 }]
  ]);
  assert.equal(fixture.createdTabs.length, 1);
  assert.equal(fixture.createdTabs[0].active, true);
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(deliveredPayload.silent, true);
  assert.equal(deliveredPayload.media, false);
  assert.equal(deliveredProtocolVersion, 3);
  assert.equal(fixture.createdNotifications.length, 1);
});

test("automatic capture marks the payload silent but still confirms success", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 7,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(payload.silent, true);
  assert.equal(payload.media, false);
  assert.equal(requiredProtocolVersion, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 7],
    ["cancel", 7],
    ["erase", { id: 7 }]
  ]);
  assert.equal(fixture.createdNotifications.length, 1);
});

test("automatic capture waits for a stabilized filename after a weak initial name", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 8,
    url: "https://mail.google.com/mail/u/0/?view=att",
    referrer: "https://mail.google.com/mail/u/0/",
    filename: "/tmp/identifier"
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, [["pause", 8]]);
  fixture.listeners.downloadChanged({
    id: 8,
    filename: { current: "/Users/test/Downloads/report.zip" }
  });
  await capture;

  assert.equal(payload.filename, "report.zip");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 8],
    ["cancel", 8],
    ["erase", { id: 8 }]
  ]);
});

test("automatic capture leaves the browser download paused when handoff delivery is ambiguous", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: true, status: 504 };
  });

  await fixture.listeners.downloadCreated({
    id: 10,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [["pause", 10]]);
  assert.match(fixture.createdNotifications[0][0].title, /Handoff Needs Attention/);
});

test("automatic capture keeps the original paused when a launched handoff is ambiguous", async () => {
  let directAttempt = true;
  const fixture = createBackgroundContext(async path => {
    if (path === "/download") {
      if (directAttempt) {
        directAttempt = false;
        throw { serverReached: false, requestMayHaveBeenSent: false };
      }
      throw { serverReached: true, status: 504 };
    }
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 11,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [["pause", 11]]);
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("automatic capture keeps filename changes that arrive during settings startup", async () => {
  let payload = null;
  let releaseStorage;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    deferStorageGetOnce: true,
    deferStorageGet(release) {
      releaseStorage = release;
    }
  });

  const capture = fixture.listeners.downloadCreated({
    id: 9,
    url: "https://mail.google.com/mail/u/0/?view=att",
    referrer: "https://mail.google.com/mail/u/0/",
    filename: "/tmp/identifier"
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, [["pause", 9]]);
  fixture.listeners.downloadChanged({
    id: 9,
    filename: { current: "/Users/test/Downloads/startup-report.zip" }
  });
  releaseStorage();
  await capture;

  assert.equal(payload.filename, "startup-report.zip");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 9],
    ["cancel", 9],
    ["erase", { id: 9 }]
  ]);
});

test("automatic capture without the cookies API remains recoverable", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, { omitCookiesApi: true });

  await fixture.listeners.downloadCreated({
    id: 12,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip",
    incognito: true
  });

  assert.equal(payload.cookies, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 12],
    ["cancel", 12],
    ["erase", { id: 12 }]
  ]);
});

test("storage startup errors do not leave a new download paused", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    storageGetResult: undefined
  });

  await fixture.listeners.downloadCreated({
    id: 13,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 13],
    ["resume", 13]
  ]);
});

test("worker restart treats an in-flight automatic handoff as ambiguous", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "14": {
        id: 14,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "sending"
      }
    },
    downloadsById: {
      14: {
        id: 14,
        url: "https://example.com/file.zip",
        state: "paused"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("worker restart safely retries a capture that never started sending", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    pendingCaptures: {
      "15": {
        id: 15,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      15: {
        id: 15,
        url: "https://example.com/file.zip",
        state: "paused"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload.filename, "file.zip");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 15],
    ["cancel", 15],
    ["erase", { id: 15 }]
  ]);
});

test("automatic Google captures carry host-scoped cookies for redirected auth", async () => {
  let payload = null;
  const gmailUrl = "https://mail.google.com/mail/u/0/?view=att";
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      return { ok: true };
    },
    {
      cookiesByUrl: {
        [gmailUrl]: [{ name: "SID", value: "mail-session" }],
        "https://mail.google.com/": [{ name: "SID", value: "mail-session" }],
        "https://accounts.google.com/": [{ name: "LSID", value: "account-session" }]
      }
    }
  );

  await vm.runInContext(
    `sendToFirelink([${JSON.stringify(gmailUrl)}], "https://mail.google.com/mail/u/0/", { captureMode: "automatic" })`,
    fixture.context
  );

  assert.equal(payload.cookies, "SID=mail-session");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.cookie_scopes)), [
    { url: gmailUrl, cookies: "SID=mail-session" },
    { url: "https://mail.google.com/", cookies: "SID=mail-session" },
    { url: "https://accounts.google.com/", cookies: "LSID=account-session" }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), [
    { url: gmailUrl },
    { url: "https://mail.google.com/" },
    { url: "https://accounts.google.com/" },
    { url: "https://googleusercontent.com/" }
  ]);
});

test("automatic Google captures keep a single non-source cookie scope", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    cookiesByUrl: {
      "https://accounts.google.com/": [
        { name: "SID", value: "account-session" }
      ]
    }
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://mail.google.com/mail/u/0/?view=att"], "", { captureMode: "automatic" })',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(payload.cookies, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.cookie_scopes)), [
    { url: "https://accounts.google.com/", cookies: "SID=account-session" }
  ]);
});

test("automatic Chrome incognito captures use the incognito cookie store", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    cookieStores: [
      { id: "normal", incognito: false },
      { id: "incognito", incognito: true }
    ],
    cookiesByUrl: {
      "https://example.com/private.zip": [
        { name: "session", value: "incognito-session" }
      ]
    }
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/private.zip"], "", { captureMode: "automatic", incognito: true })',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(payload.cookies, "session=incognito-session");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), [{
    url: "https://example.com/private.zip",
    storeId: "incognito"
  }]);
});

test("never falls back to normal-profile cookies when incognito storage is unavailable", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    cookieStores: [],
    cookiesByUrl: {
      "https://example.com/private.zip": [
        { name: "session", value: "normal-session" }
      ]
    }
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/private.zip"], "", { captureMode: "automatic", incognito: true })',
    fixture.context
  );

  assert.equal(accepted, true);
  assert.equal(payload.cookies, undefined);
  assert.deepEqual(fixture.cookieQueries, []);
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

test("does not attach browser cookies to manual single-link handoffs", async () => {
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

  assert.equal(payload.cookies, undefined);
  assert.doesNotMatch(payload.headers, /Cookie:/);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), []);
});

test("passes automatic-capture cookies through the dedicated cookie field", async () => {
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
    'sendToFirelink(["https://one.example/a.zip"], "", { captureMode: "automatic", cookieStoreId: "firefox-container-2" })',
    fixture.context
  );

  assert.equal(payload.cookies, "session=private; locale=en");
  assert.doesNotMatch(payload.headers, /Cookie:/);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), [{
    url: "https://one.example/a.zip",
    storeId: "firefox-container-2"
  }]);
});

test("link context menu sends the clicked link with page referer", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  });

  fixture.listeners.contextMenu(
    {
      menuItemId: "download-with-firelink",
      linkUrl: "https://cdn.example/file.zip"
    },
    {
      url: "https://example.com/page",
      cookieStoreId: "firefox-container-2"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://cdn.example/file.zip"],
    referer: "https://example.com/page",
    silent: false,
    headers: "User-Agent: Firefox Test",
    media: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), []);
});

test("selected-link context menu prefers extracted anchor links", async () => {
  let payload = null;
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      return { ok: true };
    },
    {
      selectionResponse: {
        links: ["https://example.com/one.zip", "https://example.com/two.zip"]
      }
    }
  );

  fixture.listeners.contextMenu(
    {
      menuItemId: "download-selected-with-firelink",
      selectionText: "https://fallback.example/ignored.zip"
    },
    {
      id: 12,
      url: "https://example.com/page",
      cookieStoreId: "firefox-container-2"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.executedScripts[0])), {
    target: { tabId: 12 },
    files: ["content.js"]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.sentMessages[0])), {
    tabId: 12,
    message: { action: "extractSelectionLinks" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://example.com/one.zip", "https://example.com/two.zip"],
    referer: "https://example.com/page",
    silent: false,
    headers: "User-Agent: Firefox Test",
    media: false
  });
});

test("selected-link context menu falls back to selected text when tab is unavailable", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  });

  assert.doesNotThrow(() => {
    fixture.listeners.contextMenu(
      {
        menuItemId: "download-selected-with-firelink",
        selectionText: "(https://example.com/file.zip),"
      },
      undefined
    );
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.executedScripts.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://example.com/file.zip"],
    referer: "",
    silent: false,
    headers: "User-Agent: Firefox Test",
    media: false
  });
});

test("popup media fetch sends the active page without a full cookie header", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      requiredProtocolVersion = request.requiredProtocolVersion;
      return { ok: true };
    },
    {
      activeTabs: [{
        url: "https://youtube.com/watch?v=abc",
        cookieStoreId: "firefox-container-2"
      }],
      cookiesByUrl: {
        "https://youtube.com/watch?v=abc": [
          { name: "oversized", value: "x".repeat(64 * 1024) }
        ]
      }
    }
  );

  const response = await new Promise(resolve => {
    const keepAlive = fixture.listeners.message(
      { action: "fetchMediaForActiveTab" },
      {},
      resolve
    );
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://youtube.com/watch?v=abc"],
    referer: "https://youtube.com/watch?v=abc",
    silent: false,
    media: true
  });
  assert.equal(requiredProtocolVersion, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.cookieQueries)), []);
});

test("media context menu sends the tab page instead of transient media src", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  fixture.listeners.contextMenu(
    {
      menuItemId: "fetch-media-with-firelink",
      srcUrl: "blob:https://youtube.com/transient"
    },
    {
      url: "https://youtube.com/watch?v=abc",
      cookieStoreId: "firefox-default"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payload.urls[0], "https://youtube.com/watch?v=abc");
  assert.equal(payload.referer, "https://youtube.com/watch?v=abc");
  assert.equal(payload.media, true);
  assert.equal(requiredProtocolVersion, 4);
});
