import fs from "node:fs/promises";
import { traceOperationSpan } from "@/quickhack_server/observability/operation-trace";
import {
  clearAllQhkeyCredentialStateCaches,
  registerQhkeyCredentialStateService,
} from "@/quickhack_server/security/qhkey-cache-invalidation.mjs";

export { clearAllQhkeyCredentialStateCaches };

export type QhkeyCredentialFreshness =
  | "CACHED_READ"
  | "FORCE_FRESH_WRITE";

type FileIdentity = {
  path: string;
  state: "FILE" | "MISSING" | "OTHER";
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type QhkeyCredentialStateStatus = {
  keyAlias: string | null;
  keyFingerprint: string | null;
  expiresAt: string | null;
  readEnabled: boolean;
};

export type QhkeyCredentialStateSnapshot<
  TCredentials,
  TStatus extends QhkeyCredentialStateStatus,
> = {
  status: TStatus;
  credentials: TCredentials | null;
  validationSignature?: string;
};

type SafeCacheEntry<TStatus extends QhkeyCredentialStateStatus> = {
  status: TStatus;
  identities: FileIdentity[];
  expiresAtMs: number;
  generation: number;
  validationSignature: string;
};

export type QhkeyCredentialStateRequest<
  TCredentials,
  TStatus extends QhkeyCredentialStateStatus,
> = {
  cacheKey: string;
  identityPaths: string[];
  freshness: QhkeyCredentialFreshness;
  requireCredentials: boolean;
  loadFresh: () => Promise<QhkeyCredentialStateSnapshot<TCredentials, TStatus>>;
  loadCredentialsFromValidatedState: (
    status: TStatus
  ) => Promise<TCredentials>;
};

const DEFAULT_QHKEY_STATE_CACHE_TTL_MS = 5000;
function validateTtlMs(value: number) {
  if (
    value !== 0 &&
    (!Number.isSafeInteger(value) || value < 250 || value > 30_000)
  ) {
    throw new Error(
      "QHKEY cache TTL must be 0 or between 250 and 30000 milliseconds."
    );
  }
  return value;
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  try {
    const stats = await fs.lstat(filePath);
    return {
      path: filePath,
      state: stats.isFile() && !stats.isSymbolicLink() ? "FILE" : "OTHER",
      dev: String(stats.dev),
      ino: String(stats.ino),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code !== "ENOENT") throw error;
    return {
      path: filePath,
      state: "MISSING",
      dev: "",
      ino: "",
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
    };
  }
}

async function readIdentities(paths: string[]) {
  return Promise.all(paths.map(fileIdentity));
}

function sameIdentities(left: FileIdentity[], right: FileIdentity[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        other != null &&
        value.path === other.path &&
        value.state === other.state &&
        value.dev === other.dev &&
        value.ino === other.ino &&
        value.size === other.size &&
        value.mtimeMs === other.mtimeMs &&
        value.ctimeMs === other.ctimeMs
      );
    })
  );
}

function identitySignature(identities: FileIdentity[]) {
  return JSON.stringify(identities);
}

export class QhkeyCredentialStateService<
  TCredentials,
  TStatus extends QhkeyCredentialStateStatus,
> {
  private readonly cache = new Map<string, SafeCacheEntry<TStatus>>();
  private readonly readInFlight = new Map<
    string,
    Promise<QhkeyCredentialStateSnapshot<TCredentials, TStatus>>
  >();
  private readonly forceInFlight = new Map<
    string,
    Promise<QhkeyCredentialStateSnapshot<TCredentials, TStatus>>
  >();
  private generation = 0;
  private minimumCacheGeneration = 0;
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = validateTtlMs(
      options.ttlMs ?? DEFAULT_QHKEY_STATE_CACHE_TTL_MS
    );
    registerQhkeyCredentialStateService(this);
  }

  async get(
    request: QhkeyCredentialStateRequest<TCredentials, TStatus>
  ): Promise<QhkeyCredentialStateSnapshot<TCredentials, TStatus>> {
    const ttlMs = this.ttlMs;
    const identities = await readIdentities(request.identityPaths);

    if (request.freshness === "CACHED_READ" && ttlMs > 0) {
      const cached = this.cache.get(request.cacheKey);
      if (
        cached &&
        cached.expiresAtMs > Date.now() &&
        sameIdentities(cached.identities, identities)
      ) {
        return traceOperationSpan("QHKEY_STATE_CACHE_HIT", async () => ({
          status: cached.status,
          credentials: request.requireCredentials && cached.status.readEnabled
            ? await request.loadCredentialsFromValidatedState(cached.status)
            : null,
        }));
      }
    }

    const inFlightMap =
      request.freshness === "FORCE_FRESH_WRITE"
        ? this.forceInFlight
        : this.readInFlight;
    const inFlightKey = `${request.cacheKey}\u0000${identitySignature(
      identities
    )}`;
    const existing = inFlightMap.get(inFlightKey);
    if (existing) {
      return traceOperationSpan("QHKEY_STATE_SINGLE_FLIGHT", async () => {
        const shared = await existing;
        if (!request.requireCredentials) {
          return { status: shared.status, credentials: null };
        }
        if (shared.credentials) return shared;
        return {
          status: shared.status,
          credentials: await request.loadCredentialsFromValidatedState(
            shared.status
          ),
        };
      });
    }

    const generation = ++this.generation;
    const probeSpanName =
      request.freshness === "FORCE_FRESH_WRITE"
        ? "QHKEY_STATE_FORCE_FRESH"
        : "QHKEY_STATE_CACHE_MISS";
    const load = traceOperationSpan(probeSpanName, async () => {
      let expectedIdentities = identities;
      let snapshot: QhkeyCredentialStateSnapshot<TCredentials, TStatus> | null = null;
      let finalIdentities = identities;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        snapshot = await traceOperationSpan(
          "QHKEY_STATE_FULL_PROBE",
          request.loadFresh
        );
        finalIdentities = await readIdentities(request.identityPaths);
        if (sameIdentities(expectedIdentities, finalIdentities)) {
          break;
        }
        if (attempt === 1) {
          throw new Error(
            "QHKEY files changed repeatedly during credential validation."
          );
        }
        expectedIdentities = finalIdentities;
      }

      if (!snapshot) {
        throw new Error("QHKEY credential validation did not produce a state.");
      }
      const previous = this.cache.get(request.cacheKey);

      if (
        generation >= this.minimumCacheGeneration &&
        (!previous || generation >= previous.generation)
      ) {
        this.cache.set(request.cacheKey, {
          status: snapshot.status,
          identities: finalIdentities,
          expiresAtMs: Date.now() + ttlMs,
          generation,
          validationSignature: snapshot.validationSignature ?? "",
        });
      }

      return snapshot;
    });
    inFlightMap.set(inFlightKey, load);

    try {
      const snapshot = await load;
      return request.requireCredentials
        ? snapshot
        : { status: snapshot.status, credentials: null };
    } finally {
      if (inFlightMap.get(inFlightKey) === load) {
        inFlightMap.delete(inFlightKey);
      }
    }
  }

  clear() {
    this.cache.clear();
    this.readInFlight.clear();
    this.forceInFlight.clear();
    this.minimumCacheGeneration = ++this.generation;
  }
}
