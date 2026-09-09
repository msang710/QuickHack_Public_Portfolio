import { Badge } from "@/quickhack_client/components/ui/badge";
import { UPLOAD_STATUSES } from "@/quickhack_shared/inspection/inspection-schema";
import type { MessageTranslator } from "@/quickhack_client/i18n/translation-contract";

// QuickHack object: 업로드 대기 목록 표에서 검수 기록의 업로드 상태를 배지로 표시합니다.
export function statusBadge(status: string, translate: MessageTranslator) {
  if (status === UPLOAD_STATUSES.done) {
    return <Badge variant="success">{translate("done")}</Badge>;
  }

  if (status === UPLOAD_STATUSES.uploading) {
    return <Badge variant="warning">{translate("uploading")}</Badge>;
  }

  if (status === UPLOAD_STATUSES.failed) {
    return <Badge variant="danger">{translate("failed")}</Badge>;
  }

  return <Badge variant="neutral">{translate("pending")}</Badge>;
}
