(function initializeFirelinkProtocol(root) {
  const START_PORT = 6412;
  const END_PORT = 6422;
  const ENDPOINT = `http://127.0.0.1:${START_PORT}`;
  const SERVER_HEADER = "X-Firelink-Server";
  const SERVER_HEADER_VALUE = "1";
  const PROTOCOL_VERSION_HEADER = "X-Firelink-Protocol-Version";
  const DISCOVERY_TIMEOUT_MS = 750;
  const REQUEST_TIMEOUT_MS = 5000;

  let preferredPort = null;

  class FirelinkRequestError extends Error {
    constructor(message, status = null, serverReached = false, requestMayHaveBeenSent = false) {
      super(message);
      this.name = "FirelinkRequestError";
      this.status = status;
      this.serverReached = serverReached;
      this.requestMayHaveBeenSent = requestMayHaveBeenSent;
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

  function isFirelinkResponse(response) {
    return response.headers.get(SERVER_HEADER) === SERVER_HEADER_VALUE;
  }

  function protocolVersion(response) {
    const value = Number(response.headers.get(PROTOCOL_VERSION_HEADER) || "0");
    return Number.isFinite(value) ? value : 0;
  }

  function requireProtocolVersion(response, minimumVersion) {
    if (!minimumVersion || protocolVersion(response) >= minimumVersion) {
      return;
    }
    throw new FirelinkRequestError(
      "Firelink desktop app must be updated for automatic capture",
      426,
      true
    );
  }

  async function requestAtPort(port, path, token, options = {}) {
    const method = options.method || "GET";
    const body = options.payload === undefined
      ? ""
      : JSON.stringify(options.payload);
    const timestamp = Date.now().toString();
    const signature = await generateHMAC(token, timestamp, body);
    const controller = options.controller || new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs || REQUEST_TIMEOUT_MS
    );

    const headers = {
      "X-Firelink-Signature": signature,
      "X-Firelink-Timestamp": timestamp
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    try {
      controller.signal.throwIfAborted();
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: body || undefined,
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function probePort(port, token, controller) {
    const response = await requestAtPort(port, "/ping", token, {
      controller,
      timeoutMs: DISCOVERY_TIMEOUT_MS
    });
    if (!isFirelinkResponse(response)) {
      throw new Error("Not a Firelink server");
    }
    return { port, response };
  }

  async function discoverServer(token) {
    if (preferredPort !== null) {
      try {
        return await probePort(preferredPort, token, new AbortController());
      } catch (error) {
        preferredPort = null;
      }
    }

    const controllers = [];
    const probes = [];
    for (let port = START_PORT; port <= END_PORT; port += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      probes.push(probePort(port, token, controller));
    }

    try {
      const server = await Promise.any(probes);
      controllers.forEach(controller => controller.abort());
      preferredPort = server.port;
      return server;
    } catch (error) {
      controllers.forEach(controller => controller.abort());
      throw new FirelinkRequestError("Firelink is unavailable");
    }
  }

  function rejectedResponse(response) {
    return new FirelinkRequestError(
      `Firelink rejected request with HTTP ${response.status}`,
      response.status,
      true
    );
  }

  async function signedFetch(path, token, options = {}) {
    const server = await discoverServer(token);
    if (server.response.status === 403) {
      throw rejectedResponse(server.response);
    }
    if (!server.response.ok) {
      throw rejectedResponse(server.response);
    }
    requireProtocolVersion(server.response, options.requiredProtocolVersion);
    if (path === "/ping") {
      return server.response;
    }

    let response;
    try {
      response = await requestAtPort(server.port, path, token, options);
    } catch (error) {
      preferredPort = null;
      throw new FirelinkRequestError(
        error && error.name === "AbortError"
          ? "Firelink request timed out"
          : "Firelink is unavailable",
        null,
        false,
        true
      );
    }

    if (!isFirelinkResponse(response)) {
      preferredPort = null;
      throw new FirelinkRequestError("Firelink connection identity changed");
    }
    requireProtocolVersion(response, options.requiredProtocolVersion);
    if (!response.ok) {
      throw rejectedResponse(response);
    }
    return response;
  }

  const api = {
    START_PORT,
    END_PORT,
    ENDPOINT,
    SERVER_HEADER,
    PROTOCOL_VERSION_HEADER,
    FirelinkRequestError,
    generateHMAC,
    protocolVersion,
    signedFetch
  };

  root.FirelinkProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
