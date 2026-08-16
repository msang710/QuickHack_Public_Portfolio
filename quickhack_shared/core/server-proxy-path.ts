// QuickHack note: 데스크톱 클라이언트가 본서버로 요청을 중계할 때 검색 조건을 보존합니다.
export function appendRequestSearchToProxyPath(
  pathname: string,
  requestSearch: string
) {
  const search = requestSearch.trim();

  if (!search || pathname.includes("?")) {
    return pathname;
  }

  return `${pathname}${search.startsWith("?") ? search : `?${search}`}`;
}
