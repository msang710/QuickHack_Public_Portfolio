import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const read = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const service = read("quickhack_server/supplies/supplies-service.ts");
assert.match(service, /strictNonNegativeInteger\(input\.quantity/);
assert.match(service, /strictPositiveMovementInteger\(input\.quantity/);
assert.match(service, /SUPPLY_MOVEMENT_OPERATION_ID_REQUIRED/);
assert.match(service, /lockAggregateKey\(tx/);
assert.match(service, /existingMovement\.after_quantity === quantity/);
assert.match(service, /observed: true, operationId/);
assert.match(service, /observed: false, operationId/);
assert.doesNotMatch(
  service,
  /existingMovement\.movement_type !== type \|\|\s*existingMovement\.quantity !== quantity/
);

const route = read("quickhack_server/api/supplies/supplies.ts");
assert.match(route, /receiptOperationId = command\.operationId/);
assert.match(route, /command\.observed[\s\S]*MUTATION_RECEIPT_OUTCOMES\.observed/);
assert.match(route, /receiptCommittedAt = command\.movement\.created_at/);
assert.match(route, /settleOptionalMutationRefresh/);

const client = read(
  "quickhack_client/components/supplies/supplies-management-view.tsx"
);
assert.match(client, /prepareSupplyMovementOperation/);
assert.match(client, /idempotencyKey: operation\.operationId/);
assert.match(client, /pendingMovementOperation\.current = null/);
assert.match(client, /SUPPLY_MOVEMENT_TYPE\.adjustment[\s\S]*\? 0[\s\S]*: 1/);

console.log("Supply movement command and client replay contract verified.");
