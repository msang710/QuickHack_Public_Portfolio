import { issueMockCoupangCredential } from "./mock-coupang-credential-client.mjs";
import { prepareProviderReplacement } from "./server-console-qhkey-common.mjs";

export async function issueMockCoupangQhkey(input) {
  const credential = await issueMockCoupangCredential({ baseUrl: input.mockServerUrl });
  const result = await prepareProviderReplacement(
    { ...input, environment: "mock" },
    "coupang",
    {
      vendorId: credential.vendorId,
      accessKey: credential.accessKey,
      secretKey: credential.secretKey,
    },
    { issuedAt: credential.issuedAt, expiresAt: credential.expiresAt }
  );
  return { ...result, credentialId: credential.credentialId };
}
