import type { KeysetPage } from "@/quickhack_shared/core/keyset-page";
import type { DetailRecord, DetailRecordGroup } from "@/quickhack_shared/device/types";

export const DEVICE_HISTORY_SECTIONS = [
  "inbounds",
  "inspections",
  "orderItems",
  "channelOrderMatches",
  "shipmentWorks",
  "returnDecisions",
] as const satisfies readonly DetailRecordGroup[];

export type DeviceHistorySection = (typeof DEVICE_HISTORY_SECTIONS)[number];

export type DeviceHistoryPage = KeysetPage<DetailRecord> & {
  section: DeviceHistorySection;
  totalCount: number;
};

export function isDeviceHistorySection(
  value: string
): value is DeviceHistorySection {
  return (DEVICE_HISTORY_SECTIONS as readonly string[]).includes(value);
}
