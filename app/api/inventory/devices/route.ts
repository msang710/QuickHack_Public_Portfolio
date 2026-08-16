// QuickHack note: 수동 재고 추가 요청을 서버 API 구현으로 연결하는 라우트입니다.
export const runtime = "nodejs";

export { GET } from "@/quickhack_server/api/inventory/device-list";
export { POST } from "@/quickhack_server/api/inventory/device";
