const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const localesSource = fs.readFileSync(
  path.join(__dirname, "..", "popup", "locales.js"),
  "utf8"
);

function createBackgroundContext(signedFetch, options = {}) {
  const createdTabs = [];
  const createdNotifications = [];
  const cookieQueries = [];
  const downloadActions = [];
  const removedTabs = [];
  const updatedTabs = [];
  const storageWrites = [];
  const alarmsCreated = [];
  const contextMenuItems = [];
  const executedScripts = [];
  const sentMessages = [];
  const listeners = {};
  const observedDownloads = new Map();
  const deferredStorageCallbacks = [];
  let deferredStorageGetCount = 0;
  let persistedPendingCaptures = options.pendingCaptures || {};
  const chrome = {
    contextMenus: {
      onClicked: {
        addListener(listener) { listeners.contextMenu = listener; }
      },
      create(item) {
        contextMenuItems.push(item);
        if (options.promiseOnly) return Promise.resolve();
        return undefined;
      },
      removeAll(callback) {
        contextMenuItems.length = 0;
        if (options.promiseOnly) return Promise.resolve();
        callback?.();
      }
    },
    cookies: {
      getAll(details, callback) {
        cookieQueries.push(details);
        if (options.promiseOnly) {
          return Promise.resolve(options.cookiesByUrl?.[details.url] || []);
        }
        callback(options.cookiesByUrl?.[details.url] || []);
      },
      getAllCookieStores(callback) {
        if (options.promiseOnly) {
          return Promise.resolve(options.cookieStores || []);
        }
        callback(options.cookieStores || []);
      }
    },
    downloads: {
      onCreated: {
        addListener(listener) {
          listeners.downloadCreated = downloadItem => {
            observedDownloads.set(downloadItem.id, {
              state: "in_progress",
              paused: true,
              ...downloadItem
            });
            return listener(downloadItem);
          };
        }
      },
      onChanged: {
        addListener(listener) { listeners.downloadChanged = listener; }
      },
      pause(id, callback) {
        downloadActions.push(["pause", id]);
        if (options.downloadActionThrows === "pause") throw new Error("pause failed");
        options.onDownloadAction?.("pause", id);
        if (options.promiseOnly) {
          return options.downloadActionErrors?.pause
            ? Promise.reject(new Error(options.downloadActionErrors.pause))
            : Promise.resolve();
        }
        if (options.downloadActionErrors?.pause) {
          chrome.runtime.lastError = { message: options.downloadActionErrors.pause };
        }
        callback();
        chrome.runtime.lastError = null;
      },
      resume(id, callback) {
        downloadActions.push(["resume", id]);
        if (options.downloadActionThrows === "resume") throw new Error("resume failed");
        if (options.promiseOnly) {
          return options.downloadActionErrors?.resume
            ? Promise.reject(new Error(options.downloadActionErrors.resume))
            : Promise.resolve();
        }
        if (options.downloadActionErrors?.resume) {
          chrome.runtime.lastError = { message: options.downloadActionErrors.resume };
        }
        callback();
        chrome.runtime.lastError = null;
      },
      cancel(id, callback) {
        downloadActions.push(["cancel", id]);
        if (options.downloadActionThrows === "cancel") throw new Error("cancel failed");
        options.onDownloadAction?.("cancel", id);
        if (options.promiseOnly) {
          return options.downloadActionErrors?.cancel
            ? Promise.reject(new Error(options.downloadActionErrors.cancel))
            : Promise.resolve();
        }
        if (options.downloadActionErrors?.cancel) {
          chrome.runtime.lastError = { message: options.downloadActionErrors.cancel };
        }
        callback();
        chrome.runtime.lastError = null;
      },
      erase(query, callback) {
        downloadActions.push(["erase", query]);
        if (options.downloadActionThrows === "erase") throw new Error("erase failed");
        if (options.promiseOnly) {
          return options.downloadActionErrors?.erase
            ? Promise.reject(new Error(options.downloadActionErrors.erase))
            : Promise.resolve();
        }
        if (options.downloadActionErrors?.erase) {
          chrome.runtime.lastError = { message: options.downloadActionErrors.erase };
        }
        callback();
        chrome.runtime.lastError = null;
      },
      search(query, callback) {
        if (options.downloadSearchThrows) throw new Error("download search failed");
        if (options.downloadSearchError) {
          if (options.promiseOnly) {
            return Promise.reject(new Error(options.downloadSearchError));
          }
          chrome.runtime.lastError = { message: options.downloadSearchError };
          callback([]);
          chrome.runtime.lastError = null;
          return;
        }
        const item = options.downloadsById?.[query.id] || observedDownloads.get(query.id);
        if (item && item.paused === undefined) item.paused = true;
        if (item && item.state === undefined) item.state = "in_progress";
        if (options.promiseOnly) {
          return Promise.resolve(item ? [item] : []);
        }
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
      onInstalled: {
        addListener(listener) { listeners.installed = listener; }
      },
      onMessage: {
        addListener(listener) { listeners.message = listener; }
      }
    },
    scripting: {
      executeScript(details, callback) {
        executedScripts.push(details);
        if (options.promiseOnly) {
          return options.scriptInjectionError
            ? Promise.reject(new Error(options.scriptInjectionError))
            : Promise.resolve([]);
        }
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
            pendingAutomaticCaptures: persistedPendingCaptures,
            ...options.settings
          };
          if (options.promiseOnly) {
            if (Object.prototype.hasOwnProperty.call(options, "storageGetResult")) {
              return Promise.resolve(options.storageGetResult);
            }
            if (options.storageGetErrorOnPending
              && Array.isArray(_keys)
              && _keys.includes("pendingAutomaticCaptures")) {
              return Promise.reject(new Error(options.storageGetErrorOnPending));
            }
            return Promise.resolve(result);
          }
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
          } else if (options.storageGetErrorOnPending
            && Array.isArray(_keys)
            && _keys.includes("pendingAutomaticCaptures")) {
            chrome.runtime.lastError = { message: options.storageGetErrorOnPending };
            callback({});
            chrome.runtime.lastError = null;
          } else {
            callback(result);
          }
        },
        set(value, callback) {
          storageWrites.push(value);
          options.beforeStorageSet?.(value);
          const storageSetFailed = options.storageSetError
            || (options.storageSetErrorAfter !== undefined
              && storageWrites.length > options.storageSetErrorAfter);
          if (options.promiseOnly) {
            if (storageSetFailed) {
              return Promise.reject(new Error(options.storageSetError || "storage unavailable"));
            }
            if (Object.prototype.hasOwnProperty.call(value, "pendingAutomaticCaptures")) {
              persistedPendingCaptures = value.pendingAutomaticCaptures;
            }
            return Promise.resolve();
          }
          if (storageSetFailed) {
            chrome.runtime.lastError = {
              message: options.storageSetError || "storage unavailable"
            };
          } else if (Object.prototype.hasOwnProperty.call(value, "pendingAutomaticCaptures")) {
            persistedPendingCaptures = value.pendingAutomaticCaptures;
          }
          callback?.();
          chrome.runtime.lastError = null;
        }
      },
      onChanged: {
        addListener(listener) { listeners.storageChanged = listener; }
      }
    },
    tabs: {
      query(_queryInfo, callback) {
        if (options.promiseOnly) return Promise.resolve(options.activeTabs || []);
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
        if (options.promiseOnly) {
          return options.protocolError
            ? Promise.reject(new Error(options.protocolError))
            : Promise.resolve({ id: createdTabs.length });
        }
        if (options.deferTabCreate) {
          Promise.resolve().then(complete);
        } else {
          complete();
        }
      },
      remove(id, callback) {
        removedTabs.push(id);
        if (options.promiseOnly) return Promise.resolve();
        if (options.deferTabRemove) {
          options.deferTabRemove(() => callback?.());
        } else {
          callback?.();
        }
      },
      update(id, details, callback) {
        updatedTabs.push({ id, details });
        if (options.promiseOnly) {
          return Promise.resolve({ id, ...details });
        }
        callback?.({ id, ...details });
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        if (options.promiseOnly) {
          return options.sendMessageError
            ? Promise.reject(new Error(options.sendMessageError))
            : Promise.resolve(options.selectionResponse || { links: [] });
        }
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
    navigator: {
      userAgent: "Firefox Test",
      language: options.language || "en-US"
    },
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Date: options.Date || Date
  });
  vm.runInContext(localesSource, context);
  vm.runInContext(backgroundSource, context);
  return {
    context,
    createdNotifications,
    createdTabs,
    removedTabs,
    updatedTabs,
    storageWrites,
    alarmsCreated,
    cookieQueries,
    downloadActions,
    contextMenuItems,
    executedScripts,
    sentMessages,
    listeners,
    getPendingCaptures: () => persistedPendingCaptures
  };
}

test("starts without unsupported Firefox notification button APIs", () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }));
  assert.equal(typeof fixture.listeners.contextMenu, "function");
  assert.equal(typeof fixture.listeners.downloadCreated, "function");
});

test("supports Promise-based WebExtensions APIs for automatic capture", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, { promiseOnly: true });

  await fixture.listeners.downloadCreated({
    id: 66,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(payload?.urls?.[0], "https://example.com/file.zip");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 66],
    ["cancel", 66],
    ["erase", { id: 66 }]
  ]);
});

test("localizes and refreshes IDM-style browser context menus", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    language: "fa-IR",
    settings: { language: "fa" }
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(
    fixture.contextMenuItems.map(item => item.title),
    [
      "دانلود با Firelink",
      "دانلود پیوندهای انتخاب‌شده با Firelink",
      "دریافت رسانه با Firelink"
    ]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.contextMenuItems.map(item => item.contexts))), [
    ["link"],
    ["selection"],
    ["page", "link", "video", "audio"]
  ]);

  fixture.listeners.storageChanged({ language: { newValue: "ru" } }, "local");
  fixture.listeners.storageChanged({ language: { newValue: "uk" } }, "local");
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(
    fixture.contextMenuItems.map(item => item.title),
    [
      "Завантажити через Firelink",
      "Завантажити вибрані посилання через Firelink",
      "Отримати медіа через Firelink"
    ]
  );
});

test("localizes background notifications from the selected popup language", async () => {
  const fixture = createBackgroundContext(
    async () => {
      throw { serverReached: true, status: 403 };
    },
    { settings: { language: "he" } }
  );

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdNotifications[0][0].title, "החיבור ל-Firelink נדחה");
  assert.equal(
    fixture.createdNotifications[0][0].message,
    "אסימון הצימוד לא תקין. עדכן אותו בחלונית של תוסף Firelink."
  );
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

test("launch fallback reports an invalid pairing token instead of a startup timeout", async () => {
  let firstRequest = true;
  const fixture = createBackgroundContext(async path => {
    if (path === "/download" && firstRequest) {
      firstRequest = false;
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }
    throw { serverReached: true, status: 403 };
  });

  const accepted = await vm.runInContext(
    'sendToFirelink(["https://example.com/file.zip"])',
    fixture.context
  );

  assert.equal(accepted, false);
  assert.equal(fixture.createdNotifications.at(-1)[0].title, "Firelink Connection Rejected");
  assert.doesNotMatch(
    fixture.createdNotifications.at(-1)[0].message,
    /browser could not open Firelink/i
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fixture.storageWrites.at(-1))),
    { launchTimeoutCount: 0, launchCooldownUntil: 0 }
  );
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

test("duplicate download-created events do not orphan the original filename waiter", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  const firstCapture = fixture.listeners.downloadCreated({
    id: 80,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  for (let attempt = 0; attempt < 20 && fixture.downloadActions.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  await fixture.listeners.downloadCreated({
    id: 80,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  fixture.listeners.downloadChanged({
    id: 80,
    filename: { current: "/Users/test/Downloads/file.zip" }
  });
  await firstCapture;

  assert.equal(handoffCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 80],
    ["cancel", 80],
    ["erase", { id: 80 }]
  ]);
});

test("automatic capture does not cancel a browser download the user resumes during handoff", async () => {
  let releaseHandoff;
  let handoffStarted;
  const handoffStartedPromise = new Promise(resolve => { handoffStarted = resolve; });
  const handoffReleasePromise = new Promise(resolve => { releaseHandoff = resolve; });
  const fixture = createBackgroundContext(async path => {
    if (path === "/download") {
      handoffStarted();
      await handoffReleasePromise;
    }
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 29,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });
  await handoffStartedPromise;
  fixture.listeners.downloadChanged({ id: 29, paused: { current: false } });
  releaseHandoff();
  await capture;

  assert.deepEqual(fixture.downloadActions, [["pause", 29]]);
  assert.equal(fixture.getPendingCaptures()["29"]?.phase, "uncertain");
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("automatic capture abandons a download that completes before handoff", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 30,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  for (let attempt = 0; attempt < 20 && fixture.downloadActions.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  fixture.listeners.downloadChanged({ id: 30, state: { current: "complete" } });
  await capture;

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, [["pause", 30]]);
  assert.equal(fixture.getPendingCaptures()["30"], undefined);
});

test("automatic capture does not recapture a download the user resumes while waiting for its filename", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 31,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  for (let attempt = 0; attempt < 20 && fixture.downloadActions.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  fixture.listeners.downloadChanged({ id: 31, paused: { current: false } });
  await capture;

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, [["pause", 31]]);
  assert.equal(fixture.getPendingCaptures()["31"], undefined);
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

test("automatic capture retains an accepted record when browser cancellation fails", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    downloadActionErrors: { cancel: "download changed" }
  });

  await fixture.listeners.downloadCreated({
    id: 32,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(fixture.downloadActions, [["pause", 32], ["cancel", 32]]);
  assert.equal(fixture.getPendingCaptures()["32"]?.phase, "uncertain");
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("automatic capture does not erase a download resumed during cleanup", async () => {
  let fixture;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    onDownloadAction(action, id) {
      if (action === "cancel") {
        fixture.listeners.downloadChanged({ id, paused: { current: false } });
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 33,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(fixture.downloadActions, [["pause", 33], ["cancel", 33]]);
  assert.equal(fixture.getPendingCaptures()["33"]?.phase, "uncertain");
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("ignores the terminal event caused by its own automatic cancellation", async () => {
  let fixture;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    onDownloadAction(action, id) {
      if (action === "cancel") {
        fixture.listeners.downloadChanged({ id, state: { current: "interrupted" } });
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 35,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 35],
    ["cancel", 35],
    ["erase", { id: 35 }]
  ]);
  assert.equal(fixture.getPendingCaptures()["35"], undefined);
});

test("manual ambiguous handoffs do not claim that no download was added", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: true, status: 504 };
  });

  const accepted = await fixture.context.sendToFirelink(
    ["https://example.com/file.zip"],
    "https://example.com/page"
  );

  assert.equal(accepted, false);
  assert.match(fixture.createdNotifications[0][0].message, /may have received/i);
  assert.doesNotMatch(fixture.createdNotifications[0][0].message, /No download was added/i);
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

test("automatic capture keeps the original paused when capture settings change during handoff", async () => {
  let fixture;
  let handoffCalls = 0;
  const signedFetch = async path => {
    if (path === "/download") {
      handoffCalls += 1;
      fixture.listeners.storageChanged({
        globalCapture: { newValue: false }
      }, "local");
    }
    return { ok: true };
  };
  fixture = createBackgroundContext(signedFetch);

  await fixture.listeners.downloadCreated({
    id: 28,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 1);
  assert.deepEqual(fixture.downloadActions, [["pause", 28]]);
  assert.ok(fixture.createdNotifications.some(args => /Handoff Needs Attention/.test(args[0].title)));
});

test("automatic capture waits for settings before pausing and keeps filename changes", async () => {
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
  assert.deepEqual(fixture.downloadActions, []);
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

test("disabled site capture leaves a new Firefox download untouched", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  }, {
    settings: {
      siteToggles: { "example.com": true }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 16,
    url: "https://downloads.example.com/file.zip",
    referrer: "https://example.com/downloads",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
});

test("disabled global capture leaves a new Firefox download untouched", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  }, {
    settings: { globalCapture: false }
  });

  await fixture.listeners.downloadCreated({
    id: 17,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
});

test("unpaired capture leaves a new Firefox download untouched", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  }, {
    settings: { extensionToken: "" }
  });

  await fixture.listeners.downloadCreated({
    id: 18,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
});

test("malformed download URLs do not enter automatic capture", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 20,
    url: "not a URL",
    referrer: "",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
});

test("malformed referrers fall back to a valid download URL", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 21,
    url: "https://example.com/file.zip",
    referrer: "not a URL",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 21],
    ["cancel", 21],
    ["erase", { id: 21 }]
  ]);
});

test("a malformed target URL remains untouched even with a valid referrer", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 22,
    url: "not a URL",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
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

  assert.deepEqual(fixture.downloadActions, []);
});

test("pending-state read errors do not erase or mutate a persisted capture", async () => {
  const pending = {
    "62": {
      id: 62,
      url: "https://example.com/file.zip",
      referrer: "https://example.com/page",
      filename: "file.zip",
      phase: "ready"
    }
  };
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: pending,
    storageGetErrorOnPending: "storage unavailable",
    downloadsById: {
      62: {
        id: 62,
        url: "https://example.com/file.zip",
        state: "in_progress",
        paused: true,
        filename: "/tmp/file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.equal(fixture.getPendingCaptures()["62"]?.phase, "ready");
});

test("download inspection errors retain a paused capture for recovery", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    downloadSearchError: "downloads unavailable"
  });

  await fixture.listeners.downloadCreated({
    id: 63,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(fixture.downloadActions, [["pause", 63]]);
  assert.equal(fixture.getPendingCaptures()["63"]?.phase, "ready");
  assert.ok(fixture.alarmsCreated.length > 0);
});

test("a setting changed during startup is not overwritten by stale storage data", async () => {
  let releaseStorage;
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    deferStorageGetOnce: true,
    deferStorageGet(release) {
      releaseStorage = release;
    }
  });

  const capture = fixture.listeners.downloadCreated({
    id: 23,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });
  await new Promise(resolve => setImmediate(resolve));
  fixture.listeners.storageChanged({
    siteToggles: { newValue: { "example.com": true } }
  }, "local");
  releaseStorage();
  await capture;

  assert.deepEqual(fixture.downloadActions, []);
});

test("automatic capture tracks a resume while settings are still loading", async () => {
  let releaseStorage;
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    deferStorageGetOnce: true,
    deferStorageGet(release) {
      releaseStorage = release;
    }
  });

  const capture = fixture.listeners.downloadCreated({
    id: 22,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });
  await new Promise(resolve => setImmediate(resolve));
  fixture.listeners.downloadChanged({ id: 22, paused: { current: false } });
  releaseStorage();
  await capture;

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getPendingCaptures())), {});
});

test("automatic capture does not pause when initial pending-state persistence fails", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    storageSetError: "storage unavailable"
  });

  await fixture.listeners.downloadCreated({
    id: 24,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), []);
});

test("automatic capture does not re-pause a download resumed during ownership persistence", async () => {
  let fixture;
  let resumed = false;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    beforeStorageSet(value) {
      if (!resumed && Object.prototype.hasOwnProperty.call(value, "pendingAutomaticCaptures")) {
        resumed = true;
        fixture.listeners.downloadChanged({ id: 25, paused: { current: false } });
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 25,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getPendingCaptures())), {});
});

test("automatic capture restores a resume that races with the pause action", async () => {
  let fixture;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    onDownloadAction(action, id) {
      if (action === "pause") {
        fixture.listeners.downloadChanged({ id, paused: { current: false } });
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 34,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(fixture.downloadActions, [["pause", 34], ["resume", 34]]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getPendingCaptures())), {});
});

test("automatic capture does not pause after capture is disabled during ownership persistence", async () => {
  let fixture;
  let changed = false;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    beforeStorageSet(value) {
      if (!changed && Object.prototype.hasOwnProperty.call(value, "pendingAutomaticCaptures")) {
        changed = true;
        fixture.listeners.storageChanged({ globalCapture: { newValue: false } }, "local");
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 20,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getPendingCaptures())), {});
});

test("automatic capture resumes when a phase update cannot be persisted", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    storageSetErrorAfter: 1
  });

  await fixture.listeners.downloadCreated({
    id: 26,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 26],
    ["resume", 26]
  ]);
});

test("disabling a site while waiting for its filename resumes the original download", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 25,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  await new Promise(resolve => setImmediate(resolve));
  fixture.listeners.storageChanged({
    siteToggles: { newValue: { "example.com": true } }
  }, "local");
  fixture.listeners.downloadChanged({
    id: 25,
    filename: { current: "/Users/test/Downloads/file.zip" }
  });
  await capture;

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, [
    ["pause", 25],
    ["resume", 25]
  ]);
});

test("worker restart resumes a paused capture when its site is disabled", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    settings: {
      siteToggles: { "example.com": true }
    },
    pendingCaptures: {
      "19": {
        id: 19,
        url: "https://downloads.example.com/file.zip",
        referrer: "https://example.com/downloads",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      19: {
        id: 19,
        url: "https://downloads.example.com/file.zip",
        state: "in_progress",
        paused: true
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, [["resume", 19]]);
});

test("worker restart never acts on a reused download ID with a different source", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "60": {
        id: 60,
        url: "https://example.com/old-file.zip",
        referrer: "https://example.com/page",
        filename: "old-file.zip",
        phase: "accepted"
      }
    },
    downloadsById: {
      60: {
        id: 60,
        url: "https://example.com/new-file.zip",
        state: "in_progress",
        paused: true,
        filename: "/tmp/new-file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.equal(fixture.getPendingCaptures()["60"], undefined);
});

test("worker restart does not re-pause a capture that was released before recovery", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "64": {
        id: 64,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      64: {
        id: 64,
        url: "https://example.com/file.zip",
        state: "in_progress",
        paused: false,
        filename: "/tmp/file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.equal(fixture.getPendingCaptures()["64"], undefined);
});

test("worker restart rejects a matching URL with a different download creation identity", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "65": {
        id: 65,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        startTime: "2026-08-26T08:00:00.000Z",
        phase: "accepted"
      }
    },
    downloadsById: {
      65: {
        id: 65,
        url: "https://example.com/file.zip",
        startTime: "2026-08-26T08:01:00.000Z",
        state: "in_progress",
        paused: true,
        filename: "/tmp/file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.equal(fixture.getPendingCaptures()["65"], undefined);
});

test("worker restart canonicalizes zero-padded pending download IDs before cleanup", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "000": {
        id: 0,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      0: {
        id: 0,
        url: "https://example.com/file.zip",
        state: "complete",
        paused: true,
        filename: "/tmp/file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getPendingCaptures())), {});
});

test("malformed persisted pairing values do not pause browser downloads", async () => {
  let handoffCalls = 0;
  const fixture = createBackgroundContext(async () => {
    handoffCalls += 1;
    return { ok: true };
  }, {
    settings: { extensionToken: { value: "not-a-token" } }
  });

  await fixture.listeners.downloadCreated({
    id: 61,
    url: "https://example.com/file.zip",
    referrer: "https://example.com/page",
    filename: "/tmp/file.zip"
  });

  assert.equal(handoffCalls, 0);
  assert.deepEqual(fixture.downloadActions, []);
});

test("worker restart resumes a disabled capture even when cleanup persistence fails", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    settings: {
      siteToggles: { "example.com": true }
    },
    storageSetError: "storage unavailable",
    pendingCaptures: {
      "27": {
        id: 27,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      27: {
        id: 27,
        url: "https://example.com/file.zip",
        state: "in_progress",
        paused: true
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, [["resume", 27]]);
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
    ["cancel", 15],
    ["erase", { id: 15 }]
  ]);
});

test("worker restart never erases an accepted capture resumed during cleanup", async () => {
  let fixture;
  fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "16": {
        id: 16,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "accepted"
      }
    },
    downloadsById: {
      16: {
        id: 16,
        url: "https://example.com/file.zip",
        state: "in_progress",
        paused: true,
        filename: "/tmp/file.zip"
      }
    },
    onDownloadAction(action, id) {
      if (action === "cancel") {
        fixture.listeners.downloadChanged({ id, paused: { current: false } });
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["cancel", 16]
  ]);
  assert.equal(fixture.getPendingCaptures()["16"]?.phase, "uncertain");
});

test("worker restart does not resume a terminal capture when capture is disabled", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    settings: {
      siteToggles: { "example.com": true }
    },
    pendingCaptures: {
      "17": {
        id: 17,
        url: "https://example.com/file.zip",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "ready"
      }
    },
    downloadsById: {
      17: {
        id: 17,
        url: "https://example.com/file.zip",
        state: "interrupted",
        paused: true,
        filename: "/tmp/file.zip"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.downloadActions, []);
  assert.equal(fixture.getPendingCaptures()["17"], undefined);
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

test("does not guess between multiple incognito cookie stores", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    cookieStores: [
      { id: "incognito-a", incognito: true },
      { id: "incognito-b", incognito: true }
    ],
    cookiesByUrl: {
      "https://example.com/private.zip": [
        { name: "session", value: "wrong-container" }
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
      id: 0,
      url: "https://example.com/page",
      title: "Example Gallery / Chapter: 1",
      cookieStoreId: "firefox-container-2"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(fixture.executedScripts[0])), {
    target: { tabId: 0 },
    files: ["content.js"]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.sentMessages[0])), {
    tabId: 0,
    message: { action: "extractSelectionLinks" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://example.com/one.zip", "https://example.com/two.zip"],
    referer: "https://example.com/page",
    silent: false,
    headers: "User-Agent: Firefox Test",
    media: false,
    batch: true,
    batch_name: "Example Gallery / Chapter: 1"
  });
});

test("selected-link context menu rejects malformed injected responses", async () => {
  let payload = null;
  const fixture = createBackgroundContext(
    async (_path, _token, request) => {
      payload = request.payload;
      return { ok: true };
    },
    {
      selectionResponse: { links: "not-an-array" }
    }
  );

  fixture.listeners.contextMenu(
    {
      menuItemId: "download-selected-with-firelink",
      selectionText: "(https://fallback.example/file.zip),"
    },
    {
      id: 0,
      url: "https://example.com/page"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(payload.urls)), [
    "https://fallback.example/file.zip"
  ]);
});

test("hands magnet links to Firelink through the existing link menu", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  fixture.listeners.contextMenu(
    {
      menuItemId: "download-with-firelink",
      linkUrl: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
    },
    { url: "https://example.com/page" }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payload.urls[0], "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567");
  assert.equal(payload.torrent, true);
  assert.equal(requiredProtocolVersion, 5);
});

test("automatically hands a clicked magnet to Firelink when the app is running", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  const response = await new Promise(resolve => {
    const keepAlive = fixture.listeners.message(
      {
        action: "captureAutomaticMagnet",
        url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
      },
      { tab: { url: "https://example.com/page" } },
      resolve
    );
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { intercepted: true, ambiguous: false });
  assert.equal(payload.torrent, true);
  assert.equal(payload.silent, true);
  assert.equal(requiredProtocolVersion, 5);
  assert.deepEqual(fixture.cookieQueries, []);
});

test("definitely declined automatic magnets use the privileged browser fallback", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    promiseOnly: true,
    settings: { extensionToken: "" }
  });

  const response = await new Promise(resolve => {
    fixture.listeners.message(
      {
        action: "captureAutomaticMagnet",
        url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
      },
      { tab: { id: 12, url: "https://example.com/page" } },
      resolve
    );
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    intercepted: true,
    fallback: true,
    ambiguous: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.updatedTabs)), [{
    id: 12,
    details: {
      url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
    }
  }]);
});

test("automatically hands a clicked magnet through launch fallback when the app is stopped", async () => {
  let payload = null;
  const calls = [];
  let downloadAttempts = 0;
  const fixture = createBackgroundContext(async (path, _token, request) => {
    calls.push(path);
    if (path === "/download" && downloadAttempts++ === 0) {
      throw { serverReached: false, requestMayHaveBeenSent: false };
    }
    if (path === "/download") {
      payload = request.payload;
    }
    return { ok: true };
  });

  const response = await new Promise(resolve => {
    fixture.listeners.message(
      {
        action: "captureAutomaticMagnet",
        url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
      },
      { tab: { url: "https://example.com/page" } },
      resolve
    );
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { intercepted: true, ambiguous: false });
  assert.equal(payload.torrent, true);
  assert.equal(fixture.createdTabs.length, 1);
  assert.ok(calls.includes("/ping"));
  assert.equal(calls.filter(path => path === "/download").length, 2);
});

test("keeps a mixed magnet selection as a batch while requiring magnet support", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  await fixture.context.sendToFirelink(
    [
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      "https://example.com/file.zip"
    ],
    "https://example.com/page",
    { batch: true, batchName: "Mixed selection" }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(payload.urls)), [
    "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    "https://example.com/file.zip"
  ]);
  assert.equal(payload.torrent, undefined);
  assert.equal(payload.batch, true);
  assert.equal(requiredProtocolVersion, 5);
});

test("hands an opaque torrent download with its settled filename", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  const capture = fixture.listeners.downloadCreated({
    id: 51,
    url: "https://example.com/download?id=opaque",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  fixture.listeners.downloadChanged({
    id: 51,
    filename: { current: "/Users/test/Downloads/example.torrent" }
  });

  // The onCreated listener waits for the filename event before entering the
  // automatic capture path.
  await capture;
  assert.equal(payload.torrent, true);
  assert.equal(payload.filename, "example.torrent");
  assert.equal(requiredProtocolVersion, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.downloadActions)), [
    ["pause", 51],
    ["cancel", 51],
    ["erase", { id: 51 }]
  ]);
});

test("classifies an opaque torrent from its browser MIME type", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  }, {
    downloadsById: {
      59: {
        id: 59,
        url: "https://example.com/download?id=opaque-torrent",
        finalUrl: "https://cdn.example.com/download?id=opaque-torrent",
        mime: "application/x-bittorrent; charset=binary",
        referrer: "https://example.com/page",
        filename: "/tmp/archive.bin"
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 59,
    url: "https://example.com/download?id=opaque-torrent",
    referrer: "https://example.com/page",
    filename: "/tmp/archive.bin",
    mime: "application/x-bittorrent; charset=binary"
  });

  assert.equal(payload.torrent, true);
  assert.equal(requiredProtocolVersion, 5);
});

test("refreshes the current filename after the filename waiter expires", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    setTimeout: callback => {
      Promise.resolve().then(callback);
      return 1;
    },
    downloadsById: {
      68: {
        id: 68,
        url: "https://example.com/download?id=opaque-late-name",
        state: "in_progress",
        paused: true,
        filename: "/Users/test/final.torrent"
      }
    }
  });

  await fixture.listeners.downloadCreated({
    id: 68,
    url: "https://example.com/download?id=opaque-late-name",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });

  assert.equal(payload.torrent, true);
  assert.equal(payload.filename, "final.torrent");
});

test("classifies a torrent reached through a redirected final URL", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    downloadsById: {
      53: {
        id: 53,
        url: "https://example.com/download?id=redirected",
        finalUrl: "https://cdn.example.com/assets/final.torrent",
        referrer: "https://example.com/page",
        filename: "/tmp/identifier"
      }
    }
  });

  const capture = fixture.listeners.downloadCreated({
    id: 53,
    url: "https://example.com/download?id=redirected",
    referrer: "https://example.com/page",
    filename: "/tmp/identifier"
  });
  fixture.listeners.downloadChanged({
    id: 53,
    filename: { current: "/Users/test/Downloads/final.torrent" }
  });

  await capture;
  assert.equal(payload.torrent, true);
  assert.equal(payload.urls[0], "https://example.com/download?id=redirected");
});

test("keeps a stored redirected final URL when an unrelated URL delta arrives", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      54: {
        id: 54,
        url: "https://example.com/download?id=redirected",
        finalUrl: "https://cdn.example.com/assets/final.torrent",
        referrer: "https://example.com/page",
        filename: "final.torrent",
        state: "in_progress",
        paused: true,
        phase: "paused"
      }
    },
    downloadsById: {
      54: {
        id: 54,
        url: "https://example.com/download?id=redirected",
        finalUrl: "https://cdn.example.com/assets/final.torrent",
        filename: "/Users/test/Downloads/final.torrent",
        state: "in_progress",
        paused: true
      }
    }
  });

  fixture.listeners.downloadChanged({
    id: 54,
    finalUrl: { current: "https://cdn.example.com/assets/final.torrent" }
  });
  await new Promise(resolve => setImmediate(resolve));
  fixture.listeners.downloadChanged({
    id: 54,
    url: { current: "https://example.com/download?id=redirected-again" }
  });
  await new Promise(resolve => setImmediate(resolve));

  const saved = fixture.storageWrites
    .map(write => write.pendingAutomaticCaptures?.["54"])
    .find(record => record?.finalUrl === "https://cdn.example.com/assets/final.torrent");
  assert.ok(saved);
  assert.equal(saved.finalUrl, "https://cdn.example.com/assets/final.torrent");
});

test("classifies a magnet reported by the browser download API", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    downloadsById: {
      55: {
        id: 55,
        url: "https://example.com/redirect",
        finalUrl: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
        referrer: "https://example.com/page",
        filename: "/tmp/download"
      }
    }
  });

  const capture = fixture.listeners.downloadCreated({
    id: 55,
    url: "https://example.com/redirect",
    referrer: "https://example.com/page",
    filename: "/tmp/download"
  });
  fixture.listeners.downloadChanged({
    id: 55,
    filename: { current: "/Users/test/download.bin" }
  });

  await capture;
  assert.equal(payload.torrent, true);
});

test("resumes a torrent download when the desktop protocol is too old", async () => {
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    if (request.requiredProtocolVersion > 4) {
      throw { serverReached: true, status: 426 };
    }
    return { ok: true };
  }, {
    settings: { protocolVersion: 4 }
  });

  await fixture.listeners.downloadCreated({
    id: 52,
    url: "https://example.com/sample.torrent",
    referrer: "https://example.com/page",
    filename: "/tmp/sample.torrent"
  });

  assert.deepEqual(fixture.downloadActions, [
    ["pause", 52],
    ["resume", 52]
  ]);
});

test("keeps a torrent capture paused when a protocol rejection may follow delivery", async () => {
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    if (request.requiredProtocolVersion > 4) {
      throw { serverReached: true, status: 426, requestMayHaveBeenSent: true };
    }
    return { ok: true };
  });

  await fixture.listeners.downloadCreated({
    id: 81,
    url: "https://example.com/sample.torrent",
    referrer: "https://example.com/page",
    filename: "/tmp/sample.torrent"
  });

  assert.deepEqual(fixture.downloadActions, [["pause", 81]]);
  assert.equal(fixture.getPendingCaptures()["81"]?.phase, "uncertain");
});

test("truncates selected-link batch titles without splitting Unicode characters", async () => {
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
      title: `${"😀".repeat(512)}x`
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payload.batch_name, "😀".repeat(512));
  assert.equal(Array.from(payload.batch_name).length, 512);
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

test("preserves significant punctuation in browser-provided download URLs", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  });

  await vm.runInContext(
    'sendToFirelink(["https://example.com/path:"])',
    fixture.context
  );

  assert.deepEqual(JSON.parse(JSON.stringify(payload.urls)), [
    "https://example.com/path:"
  ]);
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

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, ambiguous: false });
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

test("media context menu sends a clicked media page link with explicit media intent", async () => {
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
      linkUrl: "https://www.youtube.com/watch?v=abc"
    },
    {
      url: "https://www.youtube.com/playlist?list=xyz",
      cookieStoreId: "firefox-default"
    }
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    urls: ["https://www.youtube.com/watch?v=abc"],
    referer: "https://www.youtube.com/watch?v=abc",
    silent: false,
    media: true
  });
  assert.equal(requiredProtocolVersion, 4);
});

test("media intent wins over a torrent-looking page URL", async () => {
  let payload = null;
  let requiredProtocolVersion = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    requiredProtocolVersion = request.requiredProtocolVersion;
    return { ok: true };
  });

  const result = await vm.runInContext(
    'fetchMediaForTab({ url: "https://example.com/file.torrent" }, { notifyOnSuccess: false })',
    fixture.context
  );

  assert.equal(result.accepted, true);
  assert.equal(result.ambiguous, false);
  assert.equal(payload.media, true);
  assert.equal(payload.torrent, undefined);
  assert.equal(requiredProtocolVersion, 4);
});

test("reports an ambiguous media handoff so the popup cannot blindly retry", async () => {
  const fixture = createBackgroundContext(async () => {
    throw { serverReached: true, status: 504 };
  });

  const result = await vm.runInContext(
    'fetchMediaForTab({ url: "https://example.com/watch" }, { notifyOnFailure: false })',
    fixture.context
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    accepted: false,
    ambiguous: true
  });
});

test("persists a filename update after a worker restart without an in-memory waiter", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "56": {
        id: 56,
        url: "https://example.com/download?id=opaque",
        referrer: "https://example.com/page",
        filename: "identifier",
        phase: "uncertain"
      }
    },
    downloadsById: {
      56: {
        id: 56,
        url: "https://example.com/download?id=opaque",
        state: "paused",
        paused: true,
        filename: "/tmp/identifier"
      }
    }
  });

  fixture.listeners.downloadChanged({
    id: 56,
    filename: { current: "/Users/test/Downloads/restarted.torrent" }
  });
  await new Promise(resolve => setImmediate(resolve));

  const saved = fixture.storageWrites
    .map(write => write.pendingAutomaticCaptures?.["56"])
    .find(record => record?.filename === "restarted.torrent");
  assert.ok(saved);
});

test("worker restart refreshes a weak filename before retrying a paused capture", async () => {
  let payload = null;
  const fixture = createBackgroundContext(async (_path, _token, request) => {
    payload = request.payload;
    return { ok: true };
  }, {
    pendingCaptures: {
      "57": {
        id: 57,
        url: "https://example.com/download?id=opaque",
        referrer: "https://example.com/page",
        filename: "identifier",
        phase: "paused"
      }
    },
    downloadsById: {
      57: {
        id: 57,
        url: "https://example.com/download?id=opaque",
        state: "in_progress",
        paused: true,
        filename: "/tmp/identifier"
      }
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  fixture.listeners.downloadChanged({
    id: 57,
    filename: { current: "/Users/test/Downloads/restarted.torrent" }
  });
  for (let attempt = 0; attempt < 20 && !payload; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(payload?.filename, "restarted.torrent");
  assert.equal(payload?.torrent, true);
});

test("keeps a paused recovery record when the browser reports in-progress state", async () => {
  const fixture = createBackgroundContext(async () => ({ ok: true }), {
    pendingCaptures: {
      "58": {
        id: 58,
        url: "https://example.com/download?id=paused",
        referrer: "https://example.com/page",
        filename: "file.zip",
        phase: "uncertain"
      }
    },
    downloadsById: {
      58: {
        id: 58,
        url: "https://example.com/download?id=paused",
        state: "in_progress",
        paused: true,
        filename: "/tmp/file.zip"
      }
    }
  });

  fixture.listeners.downloadChanged({
    id: 58,
    state: { current: "in_progress" },
    paused: { current: true }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fixture.getPendingCaptures()["58"]?.phase, "uncertain");
});
