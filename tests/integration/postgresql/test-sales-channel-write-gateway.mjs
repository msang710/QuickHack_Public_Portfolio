import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresqlPrismaClient } from "@/quickhack_server/core/database/postgresql-client";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..", "..", "..");
const temporaryDatabase = createTemporaryDatabase("quickhack-write-gateway-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
const timestamp = new Date("2026-07-18T08:00:00.000Z");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertBlocked(operation, message) {
  let blocked = false;

  try {
    await operation();
  } catch {
    blocked = true;
  }

  assert(blocked, message);
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const fullPath = path.join(directory, name);

    if (statSync(fullPath).isDirectory()) {
      return sourceFiles(fullPath);
    }

    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

function assertSingleWriteAdapterImport() {
  const serverRoot = path.join(projectRoot, "quickhack_server");
  const adapterPath = path.join(
    serverRoot,
    "sales-channel",
    "coupang",
    "write-adapter.ts"
  );
  const forbiddenNames = [
    "acknowledgeCoupangOrdersheets",
    "approveCoupangReturnRequest",
    "confirmCoupangReturnReceived",
    "stopCoupangReturnShipment",
  ];
  const violations = [];

  for (const filePath of sourceFiles(serverRoot)) {
    if (filePath === adapterPath) continue;
    const source = readFileSync(filePath, "utf8");
    const importPattern =
      /import\s*\{([\s\S]*?)\}\s*from\s*["']@\/quickhack_server\/sales-channel\/coupang\/api-client["']/g;

    for (const match of source.matchAll(importPattern)) {
      if (forbiddenNames.some((name) => match[1].includes(name))) {
        violations.push(path.relative(projectRoot, filePath));
      }
    }
  }

  assert(
    violations.length === 0,
    `Write API imports bypass the gateway: ${violations.join(", ")}`
  );
}

function assertClientReviewProxyForwardsPatchBody() {
  const routePath = path.join(
    projectRoot,
    "quickhack_server",
    "api",
    "admin",
    "sales-channel-write-requests.ts"
  );
  const source = readFileSync(routePath, "utf8");
  const patchStart = source.indexOf("export async function PATCH");
  const serverHandlerStart = source.indexOf("\n  const [", patchStart);
  const clientProxySource = source.slice(patchStart, serverHandlerStart);

  assert(patchStart >= 0 && serverHandlerStart > patchStart);
  assert(
    clientProxySource.includes("const bodyText = await request.text();"),
    "Client review PATCH proxy must read the original request body."
  );
  assert(
    clientProxySource.includes("body: bodyText"),
    "Client review PATCH proxy must forward the original request body."
  );
}

assertSingleWriteAdapterImport();
assertClientReviewProxyForwardsPatchBody();

const { client: prisma } = createPostgresqlPrismaClient({
  connectionString: temporaryDatabase.databaseUrl,
  applicationName: "quickhack-test-sales-channel-write-gateway",
});

try {
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: "PENDING",
      idempotency_key: "TEST:ORDER:1",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/test",
      source_menu_key: "shipment-all-orders",
      source_entity_type: "COUPANG_SHIPMENT_BATCH",
      source_entity_id: "TEST-BATCH",
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const target = await prisma.sales_channel_write_request_targets.create({
    data: {
      sales_channel_write_request_id:
        request.sales_channel_write_request_id,
      target_type: "SHIPMENT_BOX",
      target_external_id: "1000001",
      external_shipment_id: "1000001",
      quantity: 1,
      created_at: timestamp,
    },
  });

  await assertBlocked(
    () =>
      prisma.sales_channel_write_request_targets.update({
        where: {
          sales_channel_write_request_target_id:
            target.sales_channel_write_request_target_id,
        },
        data: { quantity: 2 },
      }),
    "Write target snapshot updates must remain blocked."
  );
  await assertBlocked(
    () =>
      prisma.sales_channel_write_request_targets.delete({
        where: {
          sales_channel_write_request_target_id:
            target.sales_channel_write_request_target_id,
        },
      }),
    "Pending write target deletion must remain blocked."
  );
  await assertBlocked(
    () =>
      prisma.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
        },
        data: { request_status: "RETRYING" },
      }),
    "Only rejected or confirmed-not-applied requests may enter RETRYING."
  );

  const attempt = await prisma.sales_channel_write_request_attempts.create({
    data: {
      sales_channel_write_request_id:
        request.sales_channel_write_request_id,
      attempt_no: 1,
      attempt_type: "WRITE",
      attempt_status: "SENDING",
      trigger_type: "TEST",
      started_at: timestamp,
      created_at: timestamp,
    },
  });
  await prisma.sales_channel_write_request_attempts.update({
    where: {
      sales_channel_write_request_attempt_id:
        attempt.sales_channel_write_request_attempt_id,
    },
    data: {
      attempt_status: "SUCCEEDED",
      completed_at: timestamp,
      request_dispatched: 1,
      response_received: 1,
    },
  });

  await assertBlocked(
    () =>
      prisma.sales_channel_write_request_attempts.update({
        where: {
          sales_channel_write_request_attempt_id:
            attempt.sales_channel_write_request_attempt_id,
        },
        data: { error_message: "overwrite" },
      }),
    "Completed attempts must be immutable."
  );

  await assertBlocked(
    () =>
      prisma.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
        },
        data: { request_status: "SUCCEEDED" },
      }),
    "Legacy aggregate statuses must be rejected."
  );
  await assertBlocked(
    () =>
      prisma.sales_channel_write_requests.create({
        data: {
          channel: "COUPANG",
          request_type: "ORDER_STATUS_INSTRUCT",
          request_status: "RETRYING",
          idempotency_key: "TEST:ORDER:RETRYING-INSERT",
          request_digest: "test-fixture",
          method: "PATCH",
          endpoint_path: "/test",
          requested_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      }),
    "RETRYING must not be a persisted request creation status."
  );

  for (const protectedStatus of [
    "SENDING",
    "VERIFYING",
    "REVIEW_REQUIRED",
    "LOCAL_PENDING",
    "COMPLETED",
    "REJECTED",
    "NOT_APPLIED",
  ]) {
    await prisma.sales_channel_write_requests.update({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      data: { request_status: protectedStatus },
    });
    await assertBlocked(
      () =>
        prisma.sales_channel_write_request_targets.delete({
          where: {
            sales_channel_write_request_target_id:
              target.sales_channel_write_request_target_id,
          },
        }),
      `${protectedStatus} write target deletion must remain blocked.`
    );
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.sales_channel_write_requests.updateMany({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
        request_status: "NOT_APPLIED",
      },
      data: { request_status: "RETRYING" },
    });
    assert(claimed.count === 1, "The retryable request was not claimed.");

    await tx.sales_channel_write_request_targets.deleteMany({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
    });
    await tx.sales_channel_write_request_targets.create({
      data: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        target_type: "SHIPMENT_BOX",
        target_external_id: "1000002",
        external_shipment_id: "1000002",
        quantity: 1,
        created_at: timestamp,
      },
    });
    await tx.sales_channel_write_requests.update({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
      data: { request_status: "PENDING" },
    });
  });

  const replaced = await prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: {
      sales_channel_write_request_id: request.sales_channel_write_request_id,
    },
    include: {
      targets: true,
      attempts: true,
    },
  });
  assert(
    replaced.request_status === "PENDING",
    "The retry transaction did not return the request to PENDING."
  );
  assert(
    replaced.targets.length === 1 &&
      replaced.targets[0].target_external_id === "1000002",
    "The retry transaction did not replace the target set."
  );
  assert(
    replaced.attempts.length === 1 &&
      replaced.attempts[0].sales_channel_write_request_attempt_id ===
        attempt.sales_channel_write_request_attempt_id,
    "The retry transaction changed completed attempt history."
  );

  console.log("Sales-channel write gateway invariants passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
