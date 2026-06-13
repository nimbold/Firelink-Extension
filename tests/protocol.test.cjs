const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  ENDPOINT,
  FirelinkRequestError,
  generateHMAC,
  signedFetch
} = require("../protocol.js");

test("uses the fixed Firelink desktop endpoint", () => {
  assert.equal(ENDPOINT, "http://127.0.0.1:23522");
});

test("generates the expected HMAC-SHA256 signature", async () => {
  const token = "pairing-token";
  const timestamp = "1710000000000";
  const body = '{"urls":["https://example.com/file.zip"]}';
  const expected = crypto
    .createHmac("sha256", token)
    .update(timestamp + body)
    .digest("hex");

  assert.equal(await generateHMAC(token, timestamp, body), expected);
});

test("signedFetch signs the exact serialized request body", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  Date.now = () => 1710000000000;
  global.fetch = async (url, options) => {
    assert.equal(url, `${ENDPOINT}/download`);
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
    return new Response(null, {
      status: 200,
      headers: { "X-Firelink-Server": "1" }
    });
  };

  try {
    await signedFetch("/download", "secret", {
      method: "POST",
      payload: {
        urls: ["https://example.com/file.zip"],
        silent: true
      }
    });
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("reports authenticated server rejections distinctly from offline errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, {
    status: 403,
    headers: { "X-Firelink-Server": "1" }
  });

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
