import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activateTestServerRuntimeConfig,
  writeTestServerRuntimeConfig,
} from "../support/runtime-config-file.mjs";

const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "quickhack-qhkey-async-state-")
);
activateTestServerRuntimeConfig(
  writeTestServerRuntimeConfig(temporaryDirectory)
);
const { runPowerShellScript } = await import(
  "@/quickhack_server/security/async-powershell.mjs"
);
const { QhkeyCredentialStateService } = await import(
  "@/quickhack_server/security/qhkey-credential-state-service"
);
const { runOperationTrace } = await import(
  "@/quickhack_server/observability/operation-trace"
);
const identityFile = path.join(temporaryDirectory, "coupang.qhkey");

function status(keyAlias) {
  return {
    channel: "COUPANG",
    providerType: "USB_QHKEY",
    status: "ACTIVE",
    keyAlias,
    keyFingerprint: `fingerprint-${keyAlias}`,
    expiresAt: "2036-01-01T00:00:00.000Z",
    readEnabled: true,
    writeEnabled: true,
    lastVerifiedAt: "2026-07-31T00:00:00.000Z",
    warningMessage: null,
    errorMessage: null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request({
  cacheKey = "COUPANG",
  freshness = "CACHED_READ",
  requireCredentials = false,
  loadFresh,
  loadCredentialsFromValidatedState = async (publicStatus) => ({
    source: publicStatus.keyAlias,
  }),
} = {}) {
  return {
    cacheKey,
    identityPaths: [identityFile],
    freshness,
    requireCredentials,
    loadFresh,
    loadCredentialsFromValidatedState,
  };
}

try {
  await fs.writeFile(identityFile, "initial-qhkey", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  if (process.platform === "win32") {
    let eventLoopAdvanced = false;
    const timer = setTimeout(() => {
      eventLoopAdvanced = true;
    }, 20);
    const output = await runPowerShellScript(
      "Start-Sleep -Milliseconds 180; [Console]::Out.Write('ready')",
      { timeoutMs: 2000, maxOutputBytes: 1024 }
    );
    clearTimeout(timer);
    assert.equal(output, "ready");
    assert.equal(
      eventLoopAdvanced,
      true,
      "The PowerShell security probe blocked the Node.js event loop."
    );

    const lineOutput = await runPowerShellScript(
      "[Console]::Out.Write([Console]::In.ReadLine())",
      {
        inputLine: "security-payload",
        timeoutMs: 2000,
        maxOutputBytes: 1024,
      }
    );
    assert.equal(lineOutput, "security-payload");

    const retryMarker = path.join(temporaryDirectory, "powershell-retry.marker");
    const retryOutput = await runPowerShellScript(
      [
        "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
        "if([System.IO.File]::Exists($path)){[Console]::Out.Write('retried')}else{[System.IO.File]::WriteAllText($path,'created'); Start-Sleep -Seconds 8}",
      ].join("; "),
      {
        inputLine: Buffer.from(retryMarker, "utf8").toString("base64"),
        timeoutMs: 5000,
        timeoutAttempts: 2,
        maxOutputBytes: 1024,
      }
    );
    assert.equal(retryOutput, "retried");

    await assert.rejects(
      runPowerShellScript("[Console]::In.ReadLine()", {
        inputLine: "first\nsecond",
      }),
      /exactly one line/i
    );

    await assert.rejects(
      runPowerShellScript("Start-Sleep -Seconds 2", {
        timeoutMs: 50,
        maxOutputBytes: 1024,
      }),
      (error) => {
        assert.equal(error.code, "POWERSHELL_TIMEOUT");
        assert.match(error.message, /timed out/i);
        return true;
      }
    );
    await assert.rejects(
      runPowerShellScript("[Console]::Out.Write('1234567890')", {
        timeoutMs: 2000,
        maxOutputBytes: 4,
      }),
      /output exceeded/i
    );
  }

  {
    const service = new QhkeyCredentialStateService();
    const gate = deferred();
    let loadCount = 0;
    const sharedRequest = request({
      requireCredentials: true,
      async loadFresh() {
        loadCount += 1;
        await gate.promise;
        return {
          status: status("single-flight"),
          credentials: { source: "fresh" },
        };
      },
    });

    const first = service.get(sharedRequest);
    const second = service.get(sharedRequest);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(loadCount, 1, "Concurrent reads did not share one validation.");
    gate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.credentials.source, "fresh");
    assert.equal(secondResult.credentials.source, "fresh");

    let cachedFreshLoadCount = 0;
    let reopenCount = 0;
    const cached = await service.get(
      request({
        requireCredentials: true,
        async loadFresh() {
          cachedFreshLoadCount += 1;
          throw new Error("A valid cached read unexpectedly revalidated.");
        },
        async loadCredentialsFromValidatedState(publicStatus) {
          reopenCount += 1;
          return { source: publicStatus.keyAlias };
        },
      })
    );
    assert.equal(cachedFreshLoadCount, 0);
    assert.equal(reopenCount, 1);
    assert.equal(cached.credentials.source, "single-flight");
  }

  {
    const service = new QhkeyCredentialStateService({ ttlMs: 250 });
    let loadCount = 0;
    const loadFresh = async () => {
      loadCount += 1;
      return {
        status: status(`identity-${loadCount}`),
        credentials: null,
      };
    };

    await service.get(request({ loadFresh }));
    await service.get(request({ loadFresh }));
    assert.equal(loadCount, 1, "An unchanged key file missed the status cache.");

    await fs.writeFile(identityFile, "changed-qhkey-with-a-new-size", "utf8");
    const changed = await service.get(request({ loadFresh }));
    assert.equal(loadCount, 2, "A changed key file did not invalidate the cache.");
    assert.equal(changed.status.keyAlias, "identity-2");

    await fs.rm(identityFile);
    const missing = await service.get(request({ loadFresh }));
    assert.equal(loadCount, 3, "A removed key file did not invalidate the cache.");
    assert.equal(missing.status.keyAlias, "identity-3");
  }

  {
    await fs.writeFile(identityFile, "restored-qhkey", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const service = new QhkeyCredentialStateService();
    let loadCount = 0;
    const loadFresh = async () => {
      loadCount += 1;
      return {
        status: status(`force-${loadCount}`),
        credentials: { source: `force-${loadCount}` },
      };
    };

    await service.get(request({ loadFresh }));
    const forced = await service.get(
      request({
        freshness: "FORCE_FRESH_WRITE",
        requireCredentials: true,
        loadFresh,
      })
    );
    assert.equal(loadCount, 2, "A write did not bypass the read cache.");
    assert.equal(forced.credentials.source, "force-2");
  }

  {
    const service = new QhkeyCredentialStateService();
    const firstProbeStarted = deferred();
    const releaseFirstProbe = deferred();
    let loadCount = 0;
    const loadFresh = async () => {
      loadCount += 1;
      const keyAlias = await fs.readFile(identityFile, "utf8");
      if (loadCount === 1) {
        firstProbeStarted.resolve();
        await releaseFirstProbe.promise;
      }
      return {
        status: status(keyAlias),
        credentials: { source: keyAlias },
      };
    };

    const first = service.get(
      request({ requireCredentials: true, loadFresh })
    );
    await firstProbeStarted.promise;
    await fs.writeFile(identityFile, "replaced-during-probe", "utf8");
    const second = service.get(
      request({ requireCredentials: true, loadFresh })
    );
    releaseFirstProbe.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status.keyAlias, "replaced-during-probe");
    assert.equal(secondResult.status.keyAlias, "replaced-during-probe");
    assert(
      loadCount >= 2,
      "A request joined a validation started for a different file identity."
    );

    const cached = await service.get(
      request({
        async loadFresh() {
          throw new Error("An unstable credential snapshot poisoned the cache.");
        },
      })
    );
    assert.equal(cached.status.keyAlias, "replaced-during-probe");
  }

  {
    const service = new QhkeyCredentialStateService();
    const gate = deferred();
    let forceCount = 0;
    const forceRequest = request({
      freshness: "FORCE_FRESH_WRITE",
      requireCredentials: true,
      async loadFresh() {
        forceCount += 1;
        await gate.promise;
        return {
          status: status("concurrent-force"),
          credentials: { source: "concurrent-force" },
        };
      },
    });
    const first = service.get(forceRequest);
    const second = service.get(forceRequest);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(forceCount, 1);
    gate.resolve();
    await Promise.all([first, second]);
  }

  {
    const service = new QhkeyCredentialStateService({ ttlMs: 250 });
    let loadCount = 0;
    const loadFresh = async () => ({
      status: status(`ttl-${++loadCount}`),
      credentials: null,
    });
    await service.get(request({ loadFresh }));
    await new Promise((resolve) => setTimeout(resolve, 280));
    const expired = await service.get(request({ loadFresh }));
    assert.equal(loadCount, 2, "An expired QHKEY state cache was reused.");
    assert.equal(expired.status.keyAlias, "ttl-2");
  }

  {
    const service = new QhkeyCredentialStateService();
    const loadFresh = async () => ({
      status: status("traced"),
      credentials: null,
    });
    let missTrace = null;
    let hitTrace = null;
    let forceTrace = null;

    await runOperationTrace(
      {
        operationName: "test.qhkey.cache-miss",
        persist: false,
        onComplete(snapshot) {
          missTrace = snapshot;
        },
      },
      () => service.get(request({ loadFresh }))
    );
    await runOperationTrace(
      {
        operationName: "test.qhkey.cache-hit",
        persist: false,
        onComplete(snapshot) {
          hitTrace = snapshot;
        },
      },
      () => service.get(request({ loadFresh }))
    );
    await runOperationTrace(
      {
        operationName: "test.qhkey.force-fresh",
        persist: false,
        onComplete(snapshot) {
          forceTrace = snapshot;
        },
      },
      () =>
        service.get(
          request({ freshness: "FORCE_FRESH_WRITE", loadFresh })
        )
    );

    assert.equal(missTrace.spans.QHKEY_STATE_CACHE_MISS?.count, 1);
    assert.equal(missTrace.spans.QHKEY_STATE_FULL_PROBE?.count, 1);
    assert.equal(hitTrace.spans.QHKEY_STATE_CACHE_HIT?.count, 1);
    assert.equal(forceTrace.spans.QHKEY_STATE_FORCE_FRESH?.count, 1);
    assert.equal(forceTrace.spans.QHKEY_STATE_FULL_PROBE?.count, 1);
  }

  {
    const service = new QhkeyCredentialStateService();
    const slowReadGate = deferred();
    const slowReadStarted = deferred();

    const slowRead = service.get(
      request({
        async loadFresh() {
          slowReadStarted.resolve();
          await slowReadGate.promise;
          return {
            status: status("stale-read"),
            credentials: null,
          };
        },
      })
    );
    await slowReadStarted.promise;

    const forced = await service.get(
      request({
        freshness: "FORCE_FRESH_WRITE",
        async loadFresh() {
          return {
            status: status("fresh-write"),
            credentials: { source: "fresh-write" },
          };
        },
      })
    );
    assert.equal(forced.status.keyAlias, "fresh-write");

    slowReadGate.resolve();
    const staleResult = await slowRead;
    assert.equal(staleResult.status.keyAlias, "stale-read");

    const cached = await service.get(
      request({
        async loadFresh() {
          throw new Error("The stale read overwrote the forced generation.");
        },
      })
    );
    assert.equal(
      cached.status.keyAlias,
      "fresh-write",
      "An older read validation overwrote a later forced write validation."
    );
  }

  {
    for (const invalidTtl of [249, Number.NaN, 30001]) {
      assert.throws(
        () => new QhkeyCredentialStateService({ ttlMs: invalidTtl }),
        /must be 0 or between 250 and 30000/
      );
    }
  }

  console.log("QHKey async credential state checks passed.");
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
