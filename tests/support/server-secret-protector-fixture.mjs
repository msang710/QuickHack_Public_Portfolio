export function createTestServerSecretProtector(options = {}) {
  const transform = options.transform ?? ((value) => Buffer.from(value));
  const restore = options.restore ?? transform;
  return Object.freeze({
    descriptor: Object.freeze({
      id: "server-secret-protector",
      role: "server",
      platform: options.platform ?? "test",
      state: options.state ?? "READY",
      ownerStage: options.ownerStage ?? "PR-05",
    }),
    metadata: Object.freeze({
      protection: options.protection ?? "WINDOWS_DPAPI_CURRENT_USER",
      identityScope: options.identityScope ?? "TEST_IDENTITY",
      portable: false,
      formatVersion: 1,
      lifecycle: options.lifecycle ?? "OPAQUE_PAYLOAD",
    }),
    async readProvisioned(identity) {
      if (options.readProvisioned) return options.readProvisioned(identity);
      throw new Error("No test activation credential was provisioned.");
    },
    readProvisionedSync(identity) {
      if (options.readProvisionedSync) return options.readProvisionedSync(identity);
      throw new Error("No test activation credential was provisioned.");
    },
    async protect(kind, secret) {
      return transform(secret, kind);
    },
    async unprotect(kind, payload) {
      return restore(payload, kind);
    },
    unprotectSync(kind, payload) {
      const value = restore(payload, kind);
      if (value && typeof value.then === "function") {
        throw new Error("The test secret restore function must be synchronous.");
      }
      return value;
    },
    ensureDirectory:
      options.ensureDirectory ?? (async () => undefined),
  });
}
