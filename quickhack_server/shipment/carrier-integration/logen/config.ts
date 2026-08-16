import type { CarrierApiMode } from "@/quickhack_server/shipment/carrier-integration/types";
import { requireLogenIntegrationSettings } from "@/quickhack_server/shipment/carrier-integration/logen/settings-service";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { resolveOfficialLiveApiHost } from "@/quickhack_shared/core/external-api-destination-policy";

const DEFAULT_MOCK_HOST = "http://127.0.0.1:3200";
const DEFAULT_MOCK_SENDER_NAME = "QuickHack";
const DEFAULT_MOCK_SENDER_TEL = "0200000000";
const DEFAULT_MOCK_SENDER_ADDRESS_1 = "서울특별시 송파구 테스트로 1";
const DEFAULT_MOCK_SENDER_ADDRESS_2 = "QuickHack 물류센터";
const DEFAULT_MOCK_BOX_TYPE_CODE = "AS080";
const LOGEN_REQUEST_TIMEOUT_MS = 30_000;
const LOGEN_READ_RETRY_COUNT = 2;

function normalizeMode(value: string): CarrierApiMode {
  return value.toLowerCase() === "live" ? "live" : "mock";
}

export function getLogenRuntimeConfig() {
  const runtimeConfig = runtimeConfigService.read();
  const mode = normalizeMode(runtimeConfig.endpoints.logen.mode);
  const mock = mode === "mock";
  const apiHost = (
    mock
      ? runtimeConfig.endpoints.logen.mockServerUrl || DEFAULT_MOCK_HOST
      : resolveOfficialLiveApiHost("LOGEN")
  ).replace(/\/+$/, "");

  return {
    carrierCode: "LOGEN" as const,
    mode,
    apiHost,
    timeoutMs: LOGEN_REQUEST_TIMEOUT_MS,
    readRetryCount: LOGEN_READ_RETRY_COUNT,
    writeApiEnabled: runtimeConfig.policies.logenWriteApiEnabled,
  };
}

export async function assertLogenWriteAllowed(operationName: string) {
  const runtime = getLogenRuntimeConfig();
  if (!runtime.writeApiEnabled) {
    throw new Error(`${operationName} 차단: Logen 쓰기 API가 금지 상태입니다.`);
  }

  return runtime;
}

export async function getLogenRegistrationConfig() {
  const runtime = getLogenRuntimeConfig();
  if (runtime.mode === "mock") {
    return {
      ...runtime,
      sender: {
        name: DEFAULT_MOCK_SENDER_NAME,
        tel: DEFAULT_MOCK_SENDER_TEL,
        cell: "",
        zipCode: "",
        address1: DEFAULT_MOCK_SENDER_ADDRESS_1,
        address2: DEFAULT_MOCK_SENDER_ADDRESS_2,
      },
      boxTypeCode: DEFAULT_MOCK_BOX_TYPE_CODE,
      settingsRevision: 0,
    };
  }

  const settings = await requireLogenIntegrationSettings();
  return {
    ...runtime,
    sender: settings.sender,
    boxTypeCode: settings.defaultBoxTypeCode,
    settingsRevision: settings.revision,
  };
}
