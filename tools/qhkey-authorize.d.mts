export const QHKEY_PUBLISH_HELPER_PATH: "/usr/lib/quickhack/quickhack-qhkey-publish-helper";
export function createQhkeyAuthorizationPlan(input: {
  transactionId: string;
  platform?: string;
  environment?: Record<string, string | undefined>;
}): Readonly<{
  provider: "POLKIT" | "SUDO_TTY";
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
}>;
export function authorizeQhkeyReplacement(
  transactionId: string,
  options?: Record<string, unknown>
): Promise<Readonly<{ transactionId: string; provider: string; authorized: true }>>;
