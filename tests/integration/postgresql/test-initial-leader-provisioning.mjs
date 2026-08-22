import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  INITIAL_LEADER_HANDOFF_PROTOCOL,
  INITIAL_LEADER_RESULT_PROTOCOL,
  initialLeaderHandoffLines,
  provisionInitialLeader,
  provisionInitialLeaderHandoff,
} from "../../../tools/provision-initial-leader.mjs";
import { verifyPassword } from "../../../tools/password.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const { Pool } = pg;
const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-leader-pg-"));
const interactionScope = createTemporaryDatabase("quickhack-leader-interaction-");
const normalScope = createTemporaryDatabase("quickhack-leader-normal-");
const concurrentScope = createTemporaryDatabase("quickhack-leader-concurrent-");
const handoffScope = createTemporaryDatabase("quickhack-leader-handoff-");

async function userCount(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return Number((await pool.query("SELECT COUNT(*) AS count FROM users")).rows[0].count);
  } finally {
    await pool.end();
  }
}

async function initialLeader(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return (await pool.query(
      `SELECT
         user_id,
         username,
         password_hash,
         role,
         must_change_password,
         is_active,
         credential_revision
       FROM users
       ORDER BY user_id`
    )).rows;
  } finally {
    await pool.end();
  }
}

try {
  const interactionPath = path.join(directory, "interaction.result");
  const interaction = await provisionInitialLeader({
    resultPath: interactionPath,
    allowCreate: false,
    connectionString: interactionScope.databaseUrl,
  });
  assert.equal(interaction.status, "INTERACTION_REQUIRED");
  assert.equal(await userCount(interactionScope.databaseUrl), 0);

  const createdPath = path.join(directory, "created.result");
  const created = await provisionInitialLeader({
    resultPath: createdPath,
    allowCreate: true,
    connectionString: normalScope.databaseUrl,
  });
  assert.equal(created.status, "CREATED");
  const resultText = readFileSync(createdPath, "utf8");
  assert.match(resultText, new RegExp(`^${INITIAL_LEADER_RESULT_PROTOCOL}`, "m"));
  assert.match(resultText, /^username=admin$/m);
  assert.match(resultText, /^temporaryPassword=[A-Za-z0-9_-]{32}$/m);
  assert.equal(await userCount(normalScope.databaseUrl), 1);

  const repeated = await provisionInitialLeader({
    resultPath: path.join(directory, "repeated.result"),
    allowCreate: true,
    connectionString: normalScope.databaseUrl,
  });
  assert.equal(repeated.status, "ALREADY_INITIALIZED");
  assert.equal(await userCount(normalScope.databaseUrl), 1);

  const concurrent = await Promise.all([
    provisionInitialLeader({
      resultPath: path.join(directory, "concurrent-a.result"),
      allowCreate: true,
      connectionString: concurrentScope.databaseUrl,
    }),
    provisionInitialLeader({
      resultPath: path.join(directory, "concurrent-b.result"),
      allowCreate: true,
      connectionString: concurrentScope.databaseUrl,
    }),
  ]);
  assert.deepEqual(
    concurrent.map((item) => item.status).sort(),
    ["ALREADY_INITIALIZED", "CREATED"]
  );
  assert.equal(await userCount(concurrentScope.databaseUrl), 1);

  const firstHandoff = await provisionInitialLeaderHandoff({
    connectionString: handoffScope.databaseUrl,
  });
  assert.equal(firstHandoff.status, "CREATED");
  assert.equal(firstHandoff.generation, 1);
  assert.equal(firstHandoff.username, "admin");
  assert.match(firstHandoff.temporaryPassword, /^[A-Za-z0-9_-]{32}$/u);
  const firstHandoffLines = initialLeaderHandoffLines(firstHandoff);
  assert.equal(firstHandoffLines[0], INITIAL_LEADER_HANDOFF_PROTOCOL);
  assert(firstHandoffLines.includes("status=CREATED"));
  assert(firstHandoffLines.includes(`userId=${firstHandoff.userId}`));
  assert(firstHandoffLines.includes("generation=1"));
  const firstRows = await initialLeader(handoffScope.databaseUrl);
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0].user_id, firstHandoff.userId);
  assert.equal(firstRows[0].credential_revision, 0);
  assert.equal(
    await verifyPassword(firstHandoff.temporaryPassword, firstRows[0].password_hash),
    true
  );

  const reissuedHandoff = await provisionInitialLeaderHandoff({
    pending: { userId: firstHandoff.userId, generation: firstHandoff.generation },
    connectionString: handoffScope.databaseUrl,
  });
  assert.equal(reissuedHandoff.status, "REISSUED");
  assert.equal(reissuedHandoff.userId, firstHandoff.userId);
  assert.equal(reissuedHandoff.generation, 2);
  assert.notEqual(reissuedHandoff.temporaryPassword, firstHandoff.temporaryPassword);
  const reissuedRows = await initialLeader(handoffScope.databaseUrl);
  assert.equal(reissuedRows.length, 1);
  assert.equal(reissuedRows[0].credential_revision, 1);
  assert.equal(
    await verifyPassword(firstHandoff.temporaryPassword, reissuedRows[0].password_hash),
    false
  );
  assert.equal(
    await verifyPassword(reissuedHandoff.temporaryPassword, reissuedRows[0].password_hash),
    true
  );

  await assert.rejects(
    () => provisionInitialLeaderHandoff({
      pending: { userId: firstHandoff.userId, generation: 1 },
      connectionString: handoffScope.databaseUrl,
    }),
    (error) => error.code === "INITIAL_LEADER_GENERATION_CONFLICT"
  );
  await assert.rejects(
    () => provisionInitialLeaderHandoff({
      pending: { userId: firstHandoff.userId + 1, generation: 2 },
      connectionString: handoffScope.databaseUrl,
    }),
    (error) => error.code === "INITIAL_LEADER_STATE_CONFLICT"
  );
  assert.equal((await initialLeader(handoffScope.databaseUrl)).length, 1);
  console.log("Initial PostgreSQL leader provisioning verified.");
} finally {
  interactionScope.cleanup();
  normalScope.cleanup();
  concurrentScope.cleanup();
  handoffScope.cleanup();
  rmSync(directory, { recursive: true, force: true });
}
