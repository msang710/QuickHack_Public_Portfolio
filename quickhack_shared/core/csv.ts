const CSV_FORMULA_RISK_PATTERN = /^[\u0000-\u0020]*[=+\-@]/;

export function serializeCsvCell(value: unknown) {
  const source = String(value ?? "");
  const text = CSV_FORMULA_RISK_PATTERN.test(source) ? `'${source}` : source;

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

export function serializeCsvRow(row: readonly unknown[]) {
  return row.map(serializeCsvCell).join(",");
}

export function serializeCsv(
  rows: readonly (readonly unknown[])[],
  options: { includeUtf8Bom?: boolean } = {}
) {
  const csv = rows.map(serializeCsvRow).join("\r\n");
  return options.includeUtf8Bom === false ? csv : `\ufeff${csv}`;
}
