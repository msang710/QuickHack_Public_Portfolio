import { createCafe24ReadClient } from "@/quickhack_server/integration/cafe24/client";
import { cafe24ConfigFromServerEnvironment } from "@/quickhack_server/integration/cafe24/config";

export async function probeCafe24ReadAccess(accessToken: string) {
  const config = cafe24ConfigFromServerEnvironment();
  const client = createCafe24ReadClient({ mallId: config.mallId, accessToken: () => accessToken });
  const [products, orders] = await Promise.all([
    client.listProductPreview(1),
    client.listOrderPreview(1),
  ]);
  return { provider: "CAFE24" as const, products, orders };
}
