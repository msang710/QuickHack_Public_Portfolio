import { adminKo } from "./admin.ts";
import { authKo } from "./auth.ts";
import { commonKo } from "./common.ts";
import { catalogKo } from "./catalog.ts";
import { desktopKo } from "./desktop.ts";
import { developerKo } from "./developer.ts";
import { navigationKo } from "./navigation.ts";
import { settingsKo } from "./settings.ts";
import { salesChannelKo } from "./sales-channel.ts";
import { inspectionKo } from "./inspection.ts";
import { inboundKo } from "./inbound.ts";
import { inventoryKo } from "./inventory.ts";
import { shipmentKo } from "./shipment.ts";
import { returnsKo } from "./returns.ts";
import { suppliesKo } from "./supplies.ts";
import { statisticsKo } from "./statistics.ts";

export const koMessages = { admin: adminKo, auth: authKo, catalog: catalogKo, common: commonKo, desktop: desktopKo, developer: developerKo, inbound: inboundKo, inspection: inspectionKo, inventory: inventoryKo, navigation: navigationKo, returns: returnsKo, salesChannel: salesChannelKo, settings: settingsKo, shipment: shipmentKo, statistics: statisticsKo, supplies: suppliesKo } as const;
export type QuickHackMessages = typeof koMessages;
