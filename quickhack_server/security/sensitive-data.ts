const REDACTED_ADDRESS = "[REDACTED_ADDRESS]";
const REDACTED_MEMO = "[REDACTED_MEMO]";

export function maskName(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  if (text.length <= 1) {
    return "*";
  }

  return `${text.slice(0, 1)}${"*".repeat(text.length - 1)}`;
}

export function maskPhone(value: string | null | undefined, visibleSuffix = 4) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  const suffixLength = Math.min(visibleSuffix, text.length);
  const suffix = text.slice(text.length - suffixLength);

  return `${"*".repeat(Math.max(0, text.length - suffixLength))}${suffix}`;
}

export function maskAddress(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  const parts = text.split(/\s+/).filter(Boolean);

  if (parts.length <= 2) {
    return REDACTED_ADDRESS;
  }

  return `${parts.slice(0, 2).join(" ")} ${REDACTED_ADDRESS}`;
}

export function maskMemo(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  return text ? REDACTED_MEMO : "";
}
