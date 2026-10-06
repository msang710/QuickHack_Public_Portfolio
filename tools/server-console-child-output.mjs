import { StringDecoder } from "node:string_decoder";

const MAX_PENDING_CHARACTERS = 8192;
const SAFE_DIAGNOSTIC_CODES = /\b(EACCES|EADDRINUSE|ECONNREFUSED|ENOENT|ENOSPC|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_INVALID_ARG_TYPE)\b/u;

// Child output is untrusted: even a line without a credential label can contain
// a key. Forward only a fixed diagnostic vocabulary to either log sink.
export function summarizeChildOutput(line) {
  if (!String(line).trim()) return "";
  const code = SAFE_DIAGNOSTIC_CODES.exec(line)?.[1];
  return code ? `CHILD_OUTPUT_REDACTED code=${code}` : "CHILD_OUTPUT_REDACTED";
}

export function captureSafeChildOutput({ source, serverId, stream, target, record }) {
  if (!source) return;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line) => {
    const summary = summarizeChildOutput(line);
    if (!summary) return;
    const safeLine = record(serverId, stream, summary);
    if (safeLine) target.write(`[${serverId}:${stream}] ${safeLine}\n`);
  };
  const consume = (value) => {
    let cursor = 0;
    while (cursor < value.length) {
      const newline = value.indexOf("\n", cursor);
      const end = newline < 0 ? value.length : newline;
      while (cursor < end) {
        const length = Math.min(MAX_PENDING_CHARACTERS - pending.length, end - cursor);
        pending += value.slice(cursor, cursor + length);
        cursor += length;
        if (pending.length === MAX_PENDING_CHARACTERS) {
          emit(pending);
          pending = "";
        }
      }
      if (newline < 0) break;
      emit(pending.replace(/\r$/u, ""));
      pending = "";
      cursor += 1;
    }
  };
  source.on("data", (chunk) => consume(decoder.write(chunk)));
  source.once("end", () => {
    consume(decoder.end());
    if (pending) emit(pending);
  });
}
