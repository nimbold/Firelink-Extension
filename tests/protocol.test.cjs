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
  const protocolVersion = settings.protocolVersion || 5;
  const port = Number(new URL(url).port);
  const proofPort = settings.proofPort || port;
  const timestamp = header(options, "X-Firelink-Timestamp");
  const nonce = header(options, "X-Firelink-Client-Nonce");
  const headers = {
    "X-Firelink-Server": "1",
    "X-Firelink-Protocol-Version": String(protocolVersion)
  };
  if (settings.serverSession !== null) {
    headers["X-Firelink-Server-Session"] = settings.serverSession
      || "0123456789abcdef0123456789abcdef";
  }

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
    SERVER_SESSION_HEADER,
    SESSION_BINDING_HEADER,
    PROTOCOL_VERSION
  } = loadProtocol();

  assert.equal(START_PORT, 6412);
  assert.equal(END_PORT, 6422);
  assert.equal(ENDPOINT, "http://127.0.0.1:6412");
  assert.equal(SERVER_HEADER, "X-Firelink-Server");
  assert.equal(PROTOCOL_VERSION_HEADER, "X-Firelink-Protocol-Version");
  assert.equal(SERVER_PROOF_HEADER, "X-Firelink-Server-Proof");
  assert.equal(SERVER_PORT_HEADER, "X-Firelink-Server-Port");
  assert.equal(SERVER_SESSION_HEADER, "X-Firelink-Server-Session");
  assert.equal(SESSION_BINDING_HEADER, "X-Firelink-Session-Binding");
  assert.equal(PROTOCOL_VERSION, 4);
});

test("keeps ordinary downloads compatible with the protocol 4 desktop without session binding", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();

  global.fetch = async (url, options = {}) => firelinkResponseForRequest(
    url,
    options,
    { protocolVersion: 4, serverSession: null }
  );

  try {
    await assert.doesNotReject(() => signedFetch("/download", "secret", {
      method: "POST",
      requiredProtocolVersion: 3,
      payload: { urls: ["https://example.com/file.zip"] }
    }));
  } finally {
    global.fetch = originalFetch;
  }
});

test("uses the advertised server session when the desktop supports session binding", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();
  const expectedSession = "abcdef0123456789abcdef0123456789";
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return firelinkResponseForRequest(url, options, {
      serverSession: expectedSession
    });
  };

  try {
    await assert.doesNotReject(() => signedFetch("/download", "secret", {
      method: "POST",
      payload: { urls: ["https://example.com/file.zip"] }
    }));
    const ping = requests.find(request => request.url.endsWith("/ping"));
    const download = requests.find(request => request.url.endsWith("/download"));
    assert.ok(ping);
    assert.ok(download);
    assert.equal(header(ping.options, "X-Firelink-Server-Session"), undefined);
    assert.equal(header(download.options, "X-Firelink-Server-Session"), expectedSession);
    assert.equal(header(download.options, "X-Firelink-Session-Binding"), "1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects a protocol 4 desktop before sending a torrent handoff", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();
  let downloadRequests = 0;

  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/download")) downloadRequests += 1;
    return firelinkResponseForRequest(url, options, { protocolVersion: 4 });
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        requiredProtocolVersion: 5,
        payload: {
          urls: ["https://example.com/file.torrent"],
          torrent: true
        }
      }),
      error => {
        assert.equal(error.status, 426);
        assert.equal(error.serverReached, true);
        return true;
      }
    );
    assert.equal(downloadRequests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("preserves a desktop 403 as an invalid pairing token", async () => {
  const originalFetch = global.fetch;
  const { signedFetch } = loadProtocol();

  global.fetch = async () => new Response(null, {
    status: 403,
    headers: {
      "X-Firelink-Server": "1",
      "X-Firelink-Protocol-Version": "5"
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

test("preserves an identified startup 503 as a retryable Firelink response", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async url => {
    if (url === "http://127.0.0.1:6412/ping") {
      return new Response(null, {
        status: 503,
        headers: {
          "X-Firelink-Server": "1",
          "X-Firelink-Protocol-Version": "6"
        }
      });
    }
    throw new TypeError("Connection refused");
  };

  try {
    await assert.rejects(
      () => signedFetch("/ping", "pairing-token"),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.status, 503);
        assert.equal(error.serverReached, true);
        assert.equal(error.requestMayHaveBeenSent, false);
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
    .update(timestamp + "\n0123456789abcdef0123456789abcdef\n" + body)
    .digest("hex");

  assert.equal(
    await generateHMAC(token, timestamp, body, "0123456789abcdef0123456789abcdef"),
    expected
  );
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
    assert.match(
      download.options.headers["X-Firelink-Client-Nonce"],
      /^[a-f0-9]{32}$/i
    );
    assert.equal(
      download.options.headers["X-Firelink-Signature"],
      await generateHMAC(
        "secret",
        download.options.headers["X-Firelink-Timestamp"],
        '{"urls":["https://example.com/file.zip"]}',
        download.options.headers["X-Firelink-Server-Session"]
      )
    );
  } finally {
    Date.now = originalNow;
    global.fetch = originalFetch;
  }
});

test("does not abort the winning discovery response", async () => {
  const originalFetch = global.fetch;
  const winnerSignals = [];
  const { signedFetch } = loadProtocol();

  global.fetch = async (url, options = {}) => {
    if (url === "http://127.0.0.1:6414/ping") {
      winnerSignals.push(options.signal);
      return firelinkResponseForRequest(url, options);
    }
    throw new TypeError("Connection refused");
  };

  try {
    await signedFetch("/ping", "secret");
    assert.equal(winnerSignals.length, 1);
    assert.equal(winnerSignals[0].aborted, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("uses distinct timestamps for concurrent identical handoffs", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const downloadRequests = [];
  const { signedFetch } = loadProtocol();
  Date.now = () => 1710000000000;

  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/download")) {
      downloadRequests.push(options);
    }
    return firelinkResponseForRequest(url, options);
  };

  try {
    await Promise.all([
      signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      }),
      signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      })
    ]);

    assert.equal(downloadRequests.length, 2);
    const timestamps = downloadRequests.map(request =>
      request.headers["X-Firelink-Timestamp"]
    );
    assert.equal(new Set(timestamps).size, 2);
    assert.notEqual(
      downloadRequests[0].headers["X-Firelink-Signature"],
      downloadRequests[1].headers["X-Firelink-Signature"]
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

test("does not mark a foreign localhost response as a delivered download", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/ping")) return firelinkResponseForRequest(url, options);
    return new Response(null, { status: 200 });
  };

  try {
    await assert.rejects(
      () => signedFetch("/download", "secret", {
        method: "POST",
        payload: { urls: ["https://example.com/file.zip"] }
      }),
      error => {
        assert.ok(error instanceof FirelinkRequestError);
        assert.equal(error.serverReached, true);
        assert.equal(error.requestMayHaveBeenSent, false);
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

test("rejects a post-discovery response without a bound server proof", async () => {
  const originalFetch = global.fetch;
  const { FirelinkRequestError, signedFetch } = loadProtocol();

  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/ping")) return firelinkResponseForRequest(url, options);
    return new Response(null, {
      status: 200,
      headers: {
        "X-Firelink-Server": "1",
        "X-Firelink-Protocol-Version": "4"
      }
    });
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
  } finally {
    global.fetch = originalFetch;
  }
});
