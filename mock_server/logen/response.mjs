export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

export function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function sendMalformedJson(response) {
  const body = '{"sttsCd":"SUCCESS","data":[';
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function readRequestText(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body exceeds mock limit."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export async function readJsonObject(request) {
  const text = await readRequestText(request);
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON request body must be an object.");
  }
  return value;
}

export function itemSucceeded(item) {
  return item?.resultCd === "TRUE" || item?.resultCd === "SUCCESS";
}

export function listStatus(items, prefix = "조회결과") {
  const total = items.length;
  const success = items.filter(itemSucceeded).length;
  const sttsCd = success === total && total > 0
    ? "SUCCESS"
    : success > 0
      ? "PARTIAL SUCCESS"
      : "FAIL";
  return {
    sttsCd,
    sttsMsg: `${prefix} ${total}건 중, ${success}건 성공`,
  };
}

export function requiredText(value) {
  return String(value ?? "").trim();
}
