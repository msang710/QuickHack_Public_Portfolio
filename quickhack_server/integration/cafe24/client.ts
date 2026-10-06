import { cafe24Origin } from "@/quickhack_server/integration/cafe24/config";
import { cafe24OrderPreview, cafe24ProductPreview } from "@/quickhack_server/integration/cafe24/order-schema";

export function createCafe24ReadClient({
  mallId,
  accessToken,
  fetchImpl = fetch,
}: { mallId: string; accessToken: () => string; fetchImpl?: typeof fetch }) {
  const origin = cafe24Origin(mallId);
  async function read(path: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("Cafe24 probe limit must be 1 to 10.");
    const token = accessToken().trim();
    if (!token || /[\r\n]/.test(token)) throw new TypeError("Cafe24 access token is invalid.");
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/api/v2/admin/${path}?limit=${limit}`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error("Cafe24 read transport failed."); }
    if (!response.ok) throw new Error(`Cafe24 read request failed (${response.status}).`);
    try { return await response.json() as unknown; }
    catch { throw new Error("Cafe24 read response is invalid."); }
  }
  return {
    async listOrderPreview(limit = 1) { return cafe24OrderPreview(await read("orders", limit)); },
    async listProductPreview(limit = 1) { return cafe24ProductPreview(await read("products", limit)); },
  };
}
