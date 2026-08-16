const TEST_KEY_BYTE = 0x5a;

export function createDeterministicTotpService(totpModule) {
  const keyAccess = {
    getStatus: async () => ({
      state: "READY",
      configured: true,
      protection: "TEST_MEMORY_KEY",
    }),
    requireReady: async () => undefined,
    withKey: async (operation) => {
      const key = Buffer.alloc(32, TEST_KEY_BYTE);

      try {
        return await operation(key);
      } finally {
        key.fill(0);
      }
    },
  };

  return {
    ...totpModule,
    ...totpModule.createTotpService(keyAccess),
  };
}
