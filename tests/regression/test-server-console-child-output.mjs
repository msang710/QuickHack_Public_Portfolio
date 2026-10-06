import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { captureSafeChildOutput } from "../../tools/server-console-child-output.mjs";

for (const stream of ["stdout", "stderr"]) {
  const source = new PassThrough();
  const target = new PassThrough();
  const entries = [];
  let journal = "";
  target.setEncoding("utf8");
  target.on("data", (chunk) => { journal += chunk; });
  captureSafeChildOutput({
    source, serverId: "backend", stream, target,
    record: (server, name, line) => { entries.push({ server, name, line }); return line; },
  });
  source.write("authorization=Bearer supe");
  source.write("r-secret\nError: EADDRINUSE password=hunter2\n");
  source.write("unlabeledSecretValue\n");
  source.write("private-key-without-newline");
  source.end();
  await new Promise((resolve) => source.once("end", resolve));
  assert.deepEqual(entries.map(({ line }) => line), [
    "CHILD_OUTPUT_REDACTED",
    "CHILD_OUTPUT_REDACTED code=EADDRINUSE",
    "CHILD_OUTPUT_REDACTED",
    "CHILD_OUTPUT_REDACTED",
  ]);
  assert.match(journal, /code=EADDRINUSE/u);
  for (const secret of ["super-secret", "hunter2", "unlabeledSecretValue", "private-key-without-newline"]) {
    assert.doesNotMatch(journal, new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret, "u"));
  }
}

{
  const source = new PassThrough();
  const target = new PassThrough();
  const entries = [];
  let journal = "";
  target.setEncoding("utf8");
  target.on("data", (chunk) => { journal += chunk; });
  captureSafeChildOutput({
    source, serverId: "backend", stream: "stderr", target,
    record: (_server, _stream, line) => { entries.push(line); return line; },
  });
  source.end(`${"unlabeled-sensitive-value".repeat(5000)}\n`);
  await new Promise((resolve) => source.once("end", resolve));
  assert.ok(entries.length > 1);
  assert.ok(entries.every((line) => line === "CHILD_OUTPUT_REDACTED"));
  assert.doesNotMatch(journal, /unlabeled-sensitive-value/u);
}

console.log("Child stdout and stderr reach both sinks through one bounded safe summary.");
