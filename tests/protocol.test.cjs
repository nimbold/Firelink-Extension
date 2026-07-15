const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

function loadProtocol() {
  delete require.cache[require.resolve("../protocol.js")];
  return require("../protocol.js");
}

function header(options, name) {
  return options.headers?.[name] || options.headers?.[name.toLowerCase()];
}

function serverProof(token, timestamp, nonce, port) {
  return crypto
    .createHmac("sha256", token)
    .update(`firelink-server-proof\n${timestamp}\n${nonce}\n${port}`)
    .digest("hex");
}

function firelinkResponseForRequest(url, options = {}, settings = {}) {
  const token = settings.token || "secret";
  const status = settings.status || 200;
  const protocolVersion = settings.protocolVersion || 3;
  const port = Number(new URL(url).port);
  const proofPort = settings.proofPort || port;
  const timestamp = header(options, "X-Firelink-Timestamp");
  const nonce = header(options, "X-Firelink-Client-Nonce");
  const headers = {
    "X-Firelink-Server": "1",
    "X-Firelink-Protocol-Version": String(protocolVersion)
  };

  if (timestamp && nonce) {
    headers["X-Firelink-Server-Port"] = String(proofPort);
    headers["X-Firelink-Server-Proof"] = serverProof(token, timestamp, nonce, proofPort);
  }

  return new Response(null, { status, headers });
}

function legacyFirelinkResponse(status = 200) {
  return new Response(null, {
    status,
    headers: {
      "X-Firelink-Server": "1",
      "X-Firelink-Protocol-Version": "2"
    }
  });
}

test("uses desktop port range server identity headers", () => {
  const {
    START_PORT,
    END_PORT,
    ENDPOINT,
    SERVER_HEADER,
    PROTOCOL_VERSION_HEADER,
    SERVER_PROOF_HEADER,
    SERVER_PORT_HEADER,
    PROTOCOL_VERSION
  } = loadProtocol();

  assert.equal(START_PORT, 6412);
  assert.equal(END_PORT, 6422);
  assert.equal(ENDPOINT, "http://127.0.0.1:6412");
  assert.equal(SERVER_HEADER, "X-Firelink-Server");
  assert.equal(PROTOCOL_VERSION_HEADER, "X-Firelink-Protocol-Version");
  assert.equal(SERVER_PROOF_HEADER, "X-Firelink-Server-Proof");
  assert.equal(SERVER_PORT_HEADER, "X-Firelink-Server-Port");
  assert.equal(PROTOCOL_VERSION, 3);
});

test("preserves a desktop 403 as an invalid pairing token", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();

  global.fetch = async () => new Response(null, {
    status: 403,
    headers: {
      "X-Firelink-Server": "1",
      "X-Firelink-Protocol-Version": "4"
    }
  });

  try {
    await assert.rejects(
      () => signedFetch("/ping", "wrong-token"),
      error => {
        assert.equal(error.status, 403);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("does not classify an incompatible 403 responder as the desktop app", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();

  global.fetch = async () => new Response(null, {
    status: 403,
    headers: { "X-Firelink-Server": "1" }
  });

  try {
    await assert.rejects(
      () => signedFetch("/ping", "wrong-token"),
      error => {
        assert.equal(error.status, 426);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("generates expected HMAC-SHA256 request signature", async () => {
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

test("generates expected HMAC-SHA256 server proof", async () => {
  const { generateServerProof } = loadProtocol();
  const token = "pairing-token";
  const timestamp = "1710000000000";
  const nonce = "0123456789abcdef0123456789abcdef";
  const port = 6414;

  assert.equal(
    await generateServerProof(token, timestamp, nonce, port),
    serverProof(token, timestamp, nonce, port)
  );
  assert.notEqual(
    await generateServerProof(token, timestamp, nonce, port + 1),
    serverProof(token, timestamp, nonce, port)
  );
});

test("discovers Firelink before sending signed download payload", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const seen = [];
  const { generateHMAC, signedFetch } = loadProtocol();
  Date.now = () => 1710000000000;

  global.fetch = async (url, options = {}) => {
    seen.push({ url, options });
    if (url === "http://127.0.0.1:6414/ping") {
      return firelinkResponseForRequest(url, options);
    }
    if (url === "http://127.0.0.1:6414/download") {
      return firelinkResponseForRequest(url, options);
    }
    throw new TypeError("Connection refused");
  };

  try {
    await signedFetch("/download", "secret", {
      method: "POST",
      payload: { urls: ["https://example.com/file.zip"] }
    });

    const ping = seen.find(entry => entry.url.endsWith("/ping"));
    const download = seen.find(entry => entry.url.endsWith("/download"));
    assert.ok(ping);
    assert.ok(download);
    assert.equal(
      download.options.headers["X-Firelink-Signature"],
      await generateHMAC(
        "secret",
        "1710000000000",
        '{"urls":["https://example.com/file.zip"]}'
      )
    );
  } finally {
    Date.now = originalNow;
    global.fetch = originalFetch;
  }
});

test("rejects a response that lacks Firelink identity", async () => {
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

  global.fetch = async (url, options = {}) => {
    seen.push(url);
    if (url.startsWith("http://127.0.0.1:6418/")) {
      return firelinkResponseForRequest(url, options);
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

  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/ping")) return firelinkResponseForRequest(url, options);
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
        requiredProtocolVersion: 3,
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

test("rejects forged identity headers before sending download payload", async () => {
  const originalFetch = global.fetch;
  const seen = [];
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    seen.push(url);
    if (url === "http://127.0.0.1:6414/ping") {
      return new Response(null, {
        status: 200,
        headers: {
          "X-Firelink-Server": "1",
          "X-Firelink-Protocol-Version": "3"
        }
      });
    }
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
        assert.equal(error.status, 426);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
    assert.equal(seen.filter(url => url.endsWith("/download")).length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects relayed proof from a different bound port", async () => {
  const originalFetch = global.fetch;
  const seen = [];
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async (url, options = {}) => {
    seen.push(url);
    if (url === "http://127.0.0.1:6414/ping") {
      return firelinkResponseForRequest(url, options, { proofPort: 6415 });
    }
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
        assert.equal(error.status, 426);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
    assert.equal(seen.filter(url => url.endsWith("/download")).length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
