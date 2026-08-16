import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { requestBodyLimitForPath } from "../quickhack_shared/http/request-body-policy.mjs";
import {
  buildTrustedForwardingHeaders,
  hostAuthority,
  isLoopbackHost,
  normalizeHttpAuthority,
} from "./quickhack-https-forwarding.mjs";
import { QUICKHACK_HSTS_HEADER_VALUE } from "../quickhack_shared/security/transport-security-policy.mjs";
import { readClientTrustBundleSync } from "./trust-bundle.mjs";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function portValue(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || fallback), 10);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }

  return value;
}

function forwardedHeaders(request, publicAuthority) {
  return buildTrustedForwardingHeaders(
    request.headers,
    request.socket.remoteAddress,
    {
      publicAuthority,
      upstreamAuthority,
    }
  );
}

function isLoopback(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function tokenMatches(received, expected) {
  const receivedBuffer = Buffer.from(String(received || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));

  return (
    receivedBuffer.length === expectedBuffer.length &&
    expectedBuffer.length > 0 &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

const listenHost = String(process.env.QUICKHACK_HTTPS_HOST || "0.0.0.0").trim();
const listenPort = portValue("QUICKHACK_HTTPS_PORT", "3443");
const upstreamHost = String(process.env.QUICKHACK_UPSTREAM_HOST || "127.0.0.1").trim();
const upstreamPort = portValue("QUICKHACK_UPSTREAM_PORT", "3000");
const pfxPath = requiredEnv("QUICKHACK_TLS_PFX_FILE");
const passphraseFile = requiredEnv("QUICKHACK_TLS_PFX_PASSPHRASE_FILE");
const supervisorToken = requiredEnv("QUICKHACK_SUPERVISOR_TOKEN");
const upstreamAuthority = hostAuthority(upstreamHost, upstreamPort);

if (!isLoopbackHost(upstreamHost)) {
  throw new Error("QUICKHACK_UPSTREAM_HOST must be a loopback host.");
}

const pfx = fs.readFileSync(pfxPath);
const passphrase = fs.readFileSync(passphraseFile, "utf8").trim();
const metadataPath = path.join(path.dirname(pfxPath), "metadata.json");
const gatewayTrustBundle = readClientTrustBundleSync(
  path.join(path.dirname(pfxPath), "client-config")
);

if (!passphrase) {
  throw new Error("QuickHack TLS PFX passphrase file is empty.");
}

function readAllowedPublicAuthorities() {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`QuickHack TLS metadata is invalid or missing: ${metadataPath}`);
  }

  if (Number(metadata?.httpsPort) !== listenPort || !Array.isArray(metadata?.hostNames)) {
    throw new Error("QuickHack TLS metadata does not match the HTTPS gateway port.");
  }
  if (
    metadata.schemaVersion !== 2 ||
    metadata.serverUrl !== gatewayTrustBundle.origin ||
    metadata.currentCaSha256 !== gatewayTrustBundle.manifest.currentCaSha256 ||
    (metadata.previousCaSha256 ?? "") !== (gatewayTrustBundle.manifest.previousCaSha256 ?? "") ||
    (metadata.rotationNotBefore ?? "") !== (gatewayTrustBundle.manifest.rotationNotBefore ?? "")
  ) {
    throw new Error("QuickHack TLS metadata does not match the client trust bundle.");
  }

  const authorities = new Set(
    metadata.hostNames.map((hostname) => hostAuthority(hostname, listenPort))
  );
  if (authorities.size === 0) {
    throw new Error("QuickHack TLS metadata does not contain an allowed host name.");
  }
  return authorities;
}

const allowedPublicAuthorities = readAllowedPublicAuthorities();

function requestPublicAuthority(request) {
  const hostHeaderCount = request.rawHeaders.reduce(
    (count, value, index) =>
      index % 2 === 0 && String(value).toLowerCase() === "host"
        ? count + 1
        : count,
    0
  );
  const hostHeader = request.headers.host;
  if (hostHeaderCount !== 1 || Array.isArray(hostHeader)) {
    throw new Error("QuickHack HTTPS gateway received multiple Host headers.");
  }
  const authority = normalizeHttpAuthority(hostHeader);
  if (!allowedPublicAuthorities.has(authority)) {
    throw new Error("QuickHack HTTPS gateway rejected an unrecognized Host.");
  }
  return authority;
}

function requestBodyLimit(requestUrl) {
  const pathname = new URL(
    String(requestUrl || "/"),
    "https://quickhack.invalid"
  ).pathname;
  return requestBodyLimitForPath(pathname);
}

function declaredContentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) {
    return null;
  }
  if (Array.isArray(raw) || !/^\d+$/.test(String(raw))) {
    throw new Error("QuickHack HTTPS gateway received an invalid Content-Length.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("QuickHack HTTPS gateway received an invalid Content-Length.");
  }
  return value;
}

let draining = false;
const upgradeSockets = new Set();

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    connection: "close",
    "strict-transport-security": QUICKHACK_HSTS_HEADER_VALUE,
  });
  response.end(body);
}

function rejectRequestBody(response, request, status, message) {
  request.resume();
  jsonResponse(response, status, { ok: false, message });
}

function beginShutdown(reason) {
  if (draining) {
    return;
  }

  draining = true;
  console.log(`[QuickHack HTTPS] drain started. reason=${reason}`);
  for (const socket of upgradeSockets) {
    socket.destroy();
  }
  upgradeSockets.clear();
  server.close(() => {
    console.log("[QuickHack HTTPS] drain completed.");
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

const server = https.createServer(
  {
    pfx,
    passphrase,
    minVersion: "TLSv1.2",
  },
  (request, response) => {
    if (request.url === "/__quickhack_tls_health") {
      jsonResponse(response, draining ? 503 : 200, {
        ok: !draining,
        service: "quickhack-https-gateway",
        draining,
      });
      return;
    }

    if (request.url === "/__quickhack_gateway_shutdown") {
      if (
        request.method !== "POST" ||
        !isLoopback(request.socket.remoteAddress) ||
        !tokenMatches(
          request.headers["x-quickhack-supervisor-token"],
          supervisorToken
        )
      ) {
        jsonResponse(response, 404, { ok: false, message: "Not found." });
        return;
      }

      jsonResponse(response, 202, {
        ok: true,
        draining: true,
      });
      setImmediate(() => beginShutdown("supervisor"));
      return;
    }

    if (request.url?.startsWith("/api/internal/supervisor/")) {
      jsonResponse(response, 404, { ok: false, message: "Not found." });
      return;
    }

    if (draining) {
      jsonResponse(response, 503, {
        ok: false,
        message: "QuickHack HTTPS gateway is shutting down.",
      });
      return;
    }

    let headers;
    let contentLength;
    const bodyLimit = requestBodyLimit(request.url);

    try {
      const publicAuthority = requestPublicAuthority(request);
      headers = forwardedHeaders(request, publicAuthority);
      contentLength = declaredContentLength(request);
    } catch {
      rejectRequestBody(response, request, 400, "QuickHack request metadata is invalid.");
      return;
    }

    if (contentLength !== null && contentLength > bodyLimit) {
      rejectRequestBody(response, request, 413, "QuickHack request body is too large.");
      return;
    }

    let requestBodyComplete = false;
    let pendingUpstreamResponse = null;
    let pendingUpstreamError = null;
    let upstreamResponseRelayed = false;
    let receivedBytes = 0;
    let bodyRejected = false;
    let upstreamWritable = true;
    const relayUpstreamResponse = () => {
      if (
        bodyRejected ||
        upstreamResponseRelayed ||
        !requestBodyComplete ||
        !pendingUpstreamResponse
      ) {
        return;
      }
      upstreamResponseRelayed = true;
      const headers = { ...pendingUpstreamResponse.headers };
      headers["strict-transport-security"] = QUICKHACK_HSTS_HEADER_VALUE;
      response.writeHead(pendingUpstreamResponse.statusCode || 502, headers);
      pendingUpstreamResponse.pipe(response);
    };
    const relayUpstreamError = () => {
      if (
        bodyRejected ||
        response.headersSent ||
        !requestBodyComplete ||
        !pendingUpstreamError ||
        pendingUpstreamResponse
      ) {
        return;
      }
      const body = "QuickHack upstream server is unavailable.";
      response.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
        "strict-transport-security": QUICKHACK_HSTS_HEADER_VALUE,
      });
      response.end(body);
    };
    const upstream = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        if (bodyRejected) {
          upstreamResponse.destroy();
          return;
        }
        pendingUpstreamResponse = upstreamResponse;
        relayUpstreamResponse();
      }
    );

    upstream.on("close", () => {
      upstreamWritable = false;
      request.resume();
    });
    upstream.on("error", (error) => {
      upstreamWritable = false;
      request.resume();
      if (bodyRejected) {
        return;
      }
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      pendingUpstreamError = error;
      relayUpstreamError();
    });

    request.on("aborted", () => upstream.destroy());
    request.on("error", (error) => upstream.destroy(error));
    request.on("data", (chunk) => {
      if (bodyRejected) {
        return;
      }
      receivedBytes += chunk.length;
      if (receivedBytes > bodyLimit) {
        bodyRejected = true;
        pendingUpstreamResponse?.destroy();
        upstream.destroy();
        rejectRequestBody(response, request, 413, "QuickHack request body is too large.");
        return;
      }
      if (upstreamWritable && !upstream.write(chunk)) {
        request.pause();
        upstream.once("drain", () => request.resume());
      }
    });
    request.on("end", () => {
      if (!bodyRejected) {
        requestBodyComplete = true;
        if (upstreamWritable) {
          upstream.end();
        }
        relayUpstreamResponse();
        relayUpstreamError();
      }
    });
  }
);

server.on("upgrade", (request, socket, head) => {
  if (
    draining ||
    request.url?.startsWith("/api/internal/supervisor/")
  ) {
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nStrict-Transport-Security: ${QUICKHACK_HSTS_HEADER_VALUE}\r\n\r\n`
    );
    return;
  }

  let headers;

  try {
    const publicAuthority = requestPublicAuthority(request);
    headers = forwardedHeaders(request, publicAuthority);
  } catch {
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nStrict-Transport-Security: ${QUICKHACK_HSTS_HEADER_VALUE}\r\n\r\n`
    );
    return;
  }

  upgradeSockets.add(socket);
  socket.once("close", () => upgradeSockets.delete(socket));

  const upstream = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers,
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || "Switching Protocols"}\r\n`
    );
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (name.toLowerCase() === "strict-transport-security") continue;
      if (Array.isArray(value)) {
        for (const item of value) socket.write(`${name}: ${item}\r\n`);
      } else if (value !== undefined) {
        socket.write(`${name}: ${value}\r\n`);
      }
    }
    socket.write(`strict-transport-security: ${QUICKHACK_HSTS_HEADER_VALUE}\r\n`);
    socket.write("\r\n");
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on("error", () => {
    socket.end(
      `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nStrict-Transport-Security: ${QUICKHACK_HSTS_HEADER_VALUE}\r\n\r\n`
    );
  });
  upstream.end();
});

server.on("clientError", (_error, socket) => {
  socket.end(
    `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nStrict-Transport-Security: ${QUICKHACK_HSTS_HEADER_VALUE}\r\n\r\n`
  );
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `[QuickHack HTTPS] listening on https://${listenHost}:${listenPort}; upstream=http://${upstreamHost}:${upstreamPort}`
  );
});

function shutdown(signal) {
  beginShutdown(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
