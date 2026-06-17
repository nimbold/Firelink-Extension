(function initializeFirelinkProtocol(root) {
  const START_PORT = 23522;
  const END_PORT = 23531;
  const DEFAULT_TIMEOUT_MS = 2500;

  class FirelinkRequestError extends Error {
    constructor(message, status = null, serverReached = false) {
      super(message);
      this.name = "FirelinkRequestError";
      this.status = status;
      this.serverReached = serverReached;
    }
  }

  async function generateHMAC(token, timestamp, body) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(timestamp + body)
    );
    return Array.from(new Uint8Array(signature))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function signedFetch(path, token, options = {}) {
    const method = options.method || "GET";
    const body = options.payload === undefined
      ? ""
      : JSON.stringify(options.payload);
    const timestamp = Date.now().toString();
    const signature = await generateHMAC(token, timestamp, body);

    const headers = {
      "X-Firelink-Signature": signature,
      "X-Firelink-Timestamp": timestamp
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    let lastError = null;

    for (let port = START_PORT; port <= END_PORT; port++) {
      const endpoint = `http://127.0.0.1:${port}`;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs || DEFAULT_TIMEOUT_MS
      );

      try {
        const response = await fetch(`${endpoint}${path}`, {
          method,
          headers,
          body: body || undefined,
          cache: "no-store",
          signal: controller.signal
        });
        const serverReached = true;
        if (!response.ok) {
          throw new FirelinkRequestError(
            `Firelink rejected the request with HTTP ${response.status}`,
            response.status,
            serverReached
          );
        }
        return response;
      } catch (error) {
        if (error instanceof FirelinkRequestError) {
          throw error;
        }
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new FirelinkRequestError(
      lastError && lastError.name === "AbortError"
        ? "Firelink request timed out"
        : "Firelink is unavailable"
    );
  }

  const api = {
    START_PORT,
    END_PORT,
    FirelinkRequestError,
    generateHMAC,
    signedFetch
  };
  root.FirelinkProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
