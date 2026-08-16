const SQL_DATE_PATTERN = /^\d{4}-(\d{2})-(\d{2})$/;

// QuickHack object: 서버가 정한 오늘 날짜와 사용자 생일의 월·일이 같은지 판정합니다.
export function isBirthdayOnDate(
  birthDate: string | null | undefined,
  currentDate: string
) {
  const birthDateMatch = SQL_DATE_PATTERN.exec(String(birthDate ?? "").trim());
  const currentDateMatch = SQL_DATE_PATTERN.exec(currentDate);

  return Boolean(
    birthDateMatch &&
      currentDateMatch &&
      birthDateMatch[1] === currentDateMatch[1] &&
      birthDateMatch[2] === currentDateMatch[2]
  );
}
