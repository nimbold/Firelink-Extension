const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

function loadProtocol() {
  delete require.cache[require.resolve("../protocol.js")];
  return require("../protocol.js");
}

function firelinkResponse(status = 200) {
  return new Response(null, {
    status,
    headers: {
      "X-Firelink-Server": "1",
      "X-Firelink-Protocol-Version": "2"
    }
  });
}

function legacyFirelinkResponse(status = 200) {
  return new Response(null, {
    status,
    headers: { "X-Firelink-Server": "1" }
  });
}

test("uses desktop port range server identity header", () => {
  const {
    START_PORT,
    END_PORT,
    ENDPOINT,
    SERVER_HEADER,
    PROTOCOL_VERSION_HEADER
  } = loadProtocol();

  assert.equal(START_PORT, 6412);
  assert.equal(END_PORT, 6422);
  assert.equal(ENDPOINT, "http://127.0.0.1:6412");
  assert.equal(SERVER_HEADER, "X-Firelink-Server");
  assert.equal(PROTOCOL_VERSION_HEADER, "X-Firelink-Protocol-Version");
});

test("generates expected HMAC-SHA256 signature", async () => {
  const { generateHMAC } = loadProtocol();
  const token = "pairing-token";
  const timestamp = "1710000000000";
  const body = '{"urls":["https://example.com/file.zip"]}';
  const expected = crypto
    .createHmac("sha256", token)
    .update(timestamp + body)
    .digest("hex");

  assert.equal(await generateHMAC(token, timestamp, body), expected);
});

test("discovers Firelink before sending signed download payload", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const seen = [];
  const { generateHMAC, signedFetch } = loadProtocol();

  Date.now = () => 1710000000000;
  global.fetch = async (url, options = {}) => {
    seen.push({ url, options });
    if (url === "http://127.0.0.1:6414/ping") return firelinkResponse();
    if (url === "http://127.0.0.1:6414/download") {
      assert.equal(options.method, "POST");
      assert.equal(
        options.body,
        '{"urls":["https://example.com/file.zip"],"silent":true}'
      );
      assert.equal(options.headers["X-Firelink-Timestamp"], "1710000000000");
      assert.equal(
        options.headers["X-Firelink-Signature"],
        await generateHMAC("pairing-token", "1710000000000", options.body)
      );
      return firelinkResponse();
    }
    throw new TypeError("Connection refused");
  };

  try {
    await signedFetch("/download", "pairing-token", {
      method: "POST",
      payload: { urls: ["https://example.com/file.zip"], silent: true }
    });
    assert.ok(seen.some(entry => entry.url.endsWith("/ping")));
    assert.ok(seen.some(entry => entry.url.endsWith("/download")));
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("rejects spoofed localhost responses without identity header", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url === "http://127.0.0.1:6412/ping") {
      return new Response(null, { status: 200 });
    }
    throw new TypeError("Connection refused");
  };

  try {
    await assert.rejects(
      () => signedFetch("/ping", "secret"),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.serverReached, false);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("reuses verified port for later requests", async () => {
  const originalFetch = global.fetch;
  const seen = [];
  const { signedFetch } = loadProtocol();

  global.fetch = async url => {
    seen.push(url);
    if (url.startsWith("http://127.0.0.1:6418/")) {
      return firelinkResponse();
    }
    throw new TypeError("Connection refused");
  };

  try {
    await signedFetch("/ping", "secret");
    seen.length = 0;
    await signedFetch("/ping", "secret");
    assert.deepEqual(seen, ["http://127.0.0.1:6418/ping"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reports an unavailable app without sending download payload", async () => {
  const originalFetch = global.fetch;
  const seen = [];
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    seen.push(url);
    throw new TypeError("Connection refused");
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      }),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.serverReached, false);
        return true;
      }
    );
    assert.equal(seen.filter(url => url.endsWith("/download")).length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("marks post-discovery transport failure possibly delivered", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url.endsWith("/ping")) return firelinkResponse();
    throw new TypeError("Connection reset");
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      }),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.requestMayHaveBeenSent, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects automatic capture against legacy desktop protocol", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url === "http://127.0.0.1:6414/ping") return legacyFirelinkResponse();
    throw new TypeError("Connection refused");
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        requiredProtocolVersion: 2,
        payload: { urls: ["https://example.com/file.zip"], silent: true }
      }),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.status, 426);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
