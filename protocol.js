(function initializeFirelinkProtocol(root) {
  const START_PORT = 6412;
  const END_PORT = 6422;
  const ENDPOINT = `http://127.0.0.1:${START_PORT}`;
  const SERVER_HEADER = "X-Firelink-Server";
  const SERVER_HEADER_VALUE = "1";
  const PROTOCOL_VERSION_HEADER = "X-Firelink-Protocol-Version";
  const CLIENT_NONCE_HEADER = "X-Firelink-Client-Nonce";
  const SERVER_PROOF_HEADER = "X-Firelink-Server-Proof";
  const SERVER_PORT_HEADER = "X-Firelink-Server-Port";
  const SERVER_PROOF_PREFIX = "firelink-server-proof";
  const PROTOCOL_VERSION = 4;
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

  async function generateHMACMessage(token, message) {
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
      encoder.encode(message)
    );
    return Array.from(new Uint8Array(signature))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function generateHMAC(token, timestamp, body) {
    return generateHMACMessage(token, timestamp + body);
  }

  async function generateServerProof(token, timestamp, nonce, port) {
    return generateHMACMessage(
      token,
      `${SERVER_PROOF_PREFIX}\n${timestamp}\n${nonce}\n${port}`
    );
  }

  function generateNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
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

  async function verifyServerProof(response, token, timestamp, nonce, port) {
    if (!isFirelinkResponse(response)) {
      throw new Error("Not a Firelink server");
    }

    requireProtocolVersion(response, PROTOCOL_VERSION);

    if (response.status === 403) {
      throw new FirelinkRequestError(
        "Firelink rejected the pairing token",
        403,
        true
      );
    }

    const reportedPort = Number(response.headers.get(SERVER_PORT_HEADER));
    const actualProof = response.headers.get(SERVER_PROOF_HEADER) || "";
    const expectedProof = await generateServerProof(token, timestamp, nonce, port);
    if (
      reportedPort !== port ||
      !/^[a-f0-9]{64}$/i.test(actualProof) ||
      actualProof.toLowerCase() !== expectedProof
    ) {
      throw new FirelinkRequestError(
        "Firelink desktop app identity could not be verified",
        426,
        true
      );
    }
  }

  async function requestAtPort(port, path, token, options = {}) {
    const method = options.method || "GET";
    const body = options.payload === undefined
      ? ""
      : JSON.stringify(options.payload);
    const timestamp = options.timestamp || Date.now().toString();
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
    if (options.clientNonce) {
      headers[CLIENT_NONCE_HEADER] = options.clientNonce;
    }
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
    const timestamp = Date.now().toString();
    const nonce = generateNonce();
    const response = await requestAtPort(port, "/ping", token, {
      controller,
      timestamp,
      clientNonce: nonce,
      timeoutMs: DISCOVERY_TIMEOUT_MS
    });
    await verifyServerProof(response, token, timestamp, nonce, port);
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
      const authError = error.errors?.find(
        candidate => candidate instanceof FirelinkRequestError
          && candidate.status === 403
          && candidate.serverReached
      );
      if (authError) {
        throw authError;
      }
      const protocolError = error.errors?.find(
        candidate => candidate instanceof FirelinkRequestError
          && candidate.status === 426
          && candidate.serverReached
      );
      if (protocolError) {
        throw protocolError;
      }
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

    const timestamp = Date.now().toString();
    const nonce = generateNonce();
    let response;
    try {
      response = await requestAtPort(server.port, path, token, {
        ...options,
        timestamp,
        clientNonce: nonce
      });
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
    await verifyServerProof(response, token, timestamp, nonce, server.port);
    return response;
  }

  const api = {
    START_PORT,
    END_PORT,
    ENDPOINT,
    SERVER_HEADER,
    PROTOCOL_VERSION_HEADER,
    CLIENT_NONCE_HEADER,
    SERVER_PROOF_HEADER,
    SERVER_PORT_HEADER,
    PROTOCOL_VERSION,
    FirelinkRequestError,
    generateHMAC,
    generateServerProof,
    protocolVersion,
    signedFetch
  };

  root.FirelinkProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
