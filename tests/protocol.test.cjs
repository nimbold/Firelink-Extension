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
    headers: { "X-Firelink-Server": "1" }
  });
}

test("uses the desktop port range and server identity header", () => {
  const { START_PORT, END_PORT, ENDPOINT, SERVER_HEADER } = loadProtocol();
  assert.equal(START_PORT, 6412);
  assert.equal(END_PORT, 6422);
  assert.equal(ENDPOINT, "http://127.0.0.1:6412");
  assert.equal(SERVER_HEADER, "X-Firelink-Server");
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

test("discovers Firelink before sending a signed download payload", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const seen = [];
  const { generateHMAC, signedFetch } = loadProtocol();

  Date.now = () => 1710000000000;
  global.fetch = async (url, options) => {
    seen.push({ url, options });
    if (url === "http://127.0.0.1:6414/ping") {
      return firelinkResponse();
    }
    if (url === "http://127.0.0.1:6414/download") {
      assert.equal(options.method, "POST");
      assert.equal(
        options.body,
        '{"urls":["https://example.com/file.zip"],"silent":true}'
      );
      assert.equal(options.headers["X-Firelink-Timestamp"], "1710000000000");
      assert.equal(
        options.headers["X-Firelink-Signature"],
        await generateHMAC("secret", "1710000000000", options.body)
      );
      return firelinkResponse();
    }
    throw new TypeError("Connection refused");
  };

  try {
    await signedFetch("/download", "secret", {
      method: "POST",
      payload: { urls: ["https://example.com/file.zip"], silent: true }
    });
    assert.ok(seen.some(request => request.url.endsWith("/ping")));
    assert.equal(
      seen.filter(request => request.url.endsWith("/download")).length,
      1
    );
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("ignores unrelated localhost 403 responses", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url === "http://127.0.0.1:6412/ping") {
      return new Response(null, { status: 403 });
    }
    if (url === "http://127.0.0.1:6413/ping") {
      return firelinkResponse(403);
    }
    throw new TypeError("Connection refused");
  };

  try {
    await assert.rejects(
      () => signedFetch("/ping", "wrong-token"),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.status, 403);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("reuses the verified port for later requests", async () => {
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

test("reports an unavailable app without sending a download payload", async () => {
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

test("marks post-discovery transport failure as possibly delivered", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url.endsWith("/ping")) {
      return firelinkResponse();
    }
    throw new TypeError("Connection reset");
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      }),
      error => {
        assert.equal(error.requestMayHaveBeenSent, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
