import { Badge } from "@/quickhack_client/components/ui/badge";
import { UPLOAD_STATUSES } from "@/quickhack_shared/inspection/inspection-schema";

// QuickHack object: 업로드 대기 목록 표에서 검수 기록의 업로드 상태를 배지로 표시합니다.
export function statusBadge(status: string) {
  if (status === UPLOAD_STATUSES.done) {
    return <Badge variant="success">완료</Badge>;
  }

  if (status === UPLOAD_STATUSES.uploading) {
    return <Badge variant="warning">업로드중</Badge>;
  }

  if (status === UPLOAD_STATUSES.failed) {
    return <Badge variant="danger">실패</Badge>;
  }

  return <Badge variant="neutral">대기</Badge>;
}

export function statusMessageTone(message: string): "success" | "warning" {
  const normalized = message.replace(/실패\s*0[건대]/g, "");
  const warningPattern =
    /실패|오류|필요|형식|없습니다|아닙니다|차단|확인하세요|입력하세요|선택하세요|불가|올바르지|권한|없음/;

  return warningPattern.test(normalized) ? "warning" : "success";
}
