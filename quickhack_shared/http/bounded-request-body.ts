import { requestBodyLimitForPath } from "./request-body-policy.mjs";

export class RequestBodyTooLargeError extends Error {
  readonly code = "REQUEST_BODY_TOO_LARGE";
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`QuickHack request body exceeds ${limitBytes} bytes.`);
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

function declaredContentLength(request: Request) {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    throw new TypeError("Invalid Content-Length header.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Content-Length header.");
  }
  return value;
}

export async function readBoundedRequestText(
  request: Request,
  limitBytes = requestBodyLimitForPath(new URL(request.url).pathname)
) {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > limitBytes) {
    await request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError(limitBytes);
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(limitBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}
