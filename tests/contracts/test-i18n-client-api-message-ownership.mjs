import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const clientRoot = path.join(root, "quickhack_client");

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const violations = [];

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

for (const file of files(clientRoot)) {
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "message" &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      ["payload", "data", "response"].includes(
        unwrapExpression(node.expression).text
      )
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push(
        `${path.relative(root, file)}:${location.line + 1}:${location.character + 1}`
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

assert.deepEqual(
  violations,
  [],
  `client UI must localize semantic API codes and must not render response message text:\n${violations.join("\n")}`
);

console.log("Client API message ownership contract passed.");
