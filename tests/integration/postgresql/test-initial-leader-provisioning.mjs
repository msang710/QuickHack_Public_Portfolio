import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  INITIAL_LEADER_RESULT_PROTOCOL,
  provisionInitialLeader,
} from "../../../tools/provision-initial-leader.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const { Pool } = pg;
const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-leader-pg-"));
const interactionScope = createTemporaryDatabase("quickhack-leader-interaction-");
const normalScope = createTemporaryDatabase("quickhack-leader-normal-");
const concurrentScope = createTemporaryDatabase("quickhack-leader-concurrent-");

async function userCount(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return Number((await pool.query("SELECT COUNT(*) AS count FROM users")).rows[0].count);
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
  console.log("Initial PostgreSQL leader provisioning verified.");
} finally {
  interactionScope.cleanup();
  normalScope.cleanup();
  concurrentScope.cleanup();
  rmSync(directory, { recursive: true, force: true });
}
