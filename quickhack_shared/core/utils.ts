// QuickHack note: 클래스 이름 병합 등 UI에서 쓰는 작은 공통 유틸입니다.
﻿import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
