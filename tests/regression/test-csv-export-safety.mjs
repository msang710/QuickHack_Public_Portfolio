import assert from "node:assert/strict";
import {
  serializeCsv,
  serializeCsvCell,
} from "../../quickhack_client/lib/csv.ts";

assert.equal(serializeCsvCell("QuickHack"), "QuickHack");
assert.equal(serializeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
assert.equal(serializeCsvCell("+1"), "'+1");
assert.equal(serializeCsvCell("-1+2"), "'-1+2");
assert.equal(serializeCsvCell("@cmd"), "'@cmd");
assert.equal(serializeCsvCell("  =1+1"), "'  =1+1");
assert.equal(serializeCsvCell("\t@cmd"), "'\t@cmd");
assert.equal(serializeCsvCell("a,b"), '"a,b"');
assert.equal(serializeCsvCell('a"b'), '"a""b"');
assert.equal(serializeCsvCell("a\nb"), '"a\nb"');
assert.equal(
  serializeCsvCell(' =SUM("a,b")'),
  '"\' =SUM(""a,b"")"'
);

const source = [["=1+1", "safe"], ["line\nbreak", 3]];
const snapshot = JSON.stringify(source);
const csv = serializeCsv(source);

assert.equal(JSON.stringify(source), snapshot, "CSV export mutated source rows.");
assert.equal(
  csv,
  "\ufeff'=1+1,safe\r\n\"line\nbreak\",3",
  "CSV BOM, CRLF, or cell serialization changed."
);
assert.equal(
  serializeCsv(source, { includeUtf8Bom: false }).startsWith("\ufeff"),
  false
);

console.log("CSV export formula safety verified.");
