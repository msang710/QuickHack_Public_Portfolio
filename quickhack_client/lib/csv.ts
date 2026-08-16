// QuickHack note: 관리자 CSV 내보내기의 수식 주입 방어와 직렬화 규칙을 한곳에서 관리합니다.
export {
  serializeCsv,
  serializeCsvCell,
  serializeCsvRow,
} from "@/quickhack_shared/core/csv";
import { serializeCsv } from "@/quickhack_shared/core/csv";

export function downloadCsvFile(
  filename: string,
  rows: readonly (readonly unknown[])[]
) {
  const blob = new Blob([serializeCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
