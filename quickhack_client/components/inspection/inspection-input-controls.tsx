// QuickHack note: 검수 화면에서 긴 기준값을 검색 선택하는 입력 보조 컴포넌트를 모읍니다.
"use client";

import { SearchSelect, type SearchSelectOption } from "@/quickhack_client/components/ui/search-select";

// QuickHack object: 제품명과 공식 색상명처럼 긴 기준값을 검색 선택하는 공통 콤보박스입니다.
export function SearchCombobox({
  value,
  options,
  isValidValue,
  onValueChange,
  placeholder,
  searchPlaceholder,
}: {
  value: string;
  options: SearchSelectOption[];
  isValidValue: (value: string) => boolean;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
}) {
  return (
    <SearchSelect
      value={isValidValue(value) ? value : ""}
      options={options}
      placeholder={placeholder || searchPlaceholder}
      allowEmpty
      onValueChange={onValueChange}
    />
  );
}
