import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { projectRoot } from "../../support/postgresql-test-scope.mjs";

const serverRoot = path.join(projectRoot, "quickhack_server");
const stateServicePath = path.join(
  serverRoot,
  "shipment",
  "carrier-integration",
  "carrier-shipment-state-service.ts"
);
const violations = [];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

for (const filePath of sourceFiles(serverRoot)) {
  if (path.resolve(filePath) === path.resolve(stateServicePath)) continue;
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["update", "updateMany", "upsert"].includes(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "carrier_shipments"
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const dataProperty = argument.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            propertyName(property.name) === "data"
        );
        if (
          dataProperty &&
          ts.isPropertyAssignment(dataProperty) &&
          ts.isObjectLiteralExpression(dataProperty.initializer)
        ) {
          for (const property of dataProperty.initializer.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = propertyName(property.name);
            if (name === "invoice_status" || name === "shipment_status") {
              const position = sourceFile.getLineAndCharacterOfPosition(
                property.getStart(sourceFile)
              );
              violations.push(
                `${path.relative(projectRoot, filePath)}:${position.line + 1}:${name}`
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

assert.deepEqual(
  violations,
  [],
  `carrier_shipments state writes must use carrier-shipment-state-service:\n${violations.join(
    "\n"
  )}`
);

console.log("Carrier shipment state write boundary verified.");
