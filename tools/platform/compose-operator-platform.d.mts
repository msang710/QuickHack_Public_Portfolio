import type { OperatorPlatform, OperatorPlatformCapabilities } from "./contracts.mjs";

export type OperatorPlatformFactory = (
  platform: string
) => OperatorPlatformCapabilities | OperatorPlatform;

export type ComposeOperatorPlatformOptions = Readonly<{
  platform?: string;
  adapters?: Readonly<Record<string, OperatorPlatformFactory>>;
}>;

export function composeOperatorPlatform(
  options?: ComposeOperatorPlatformOptions
): OperatorPlatform;
