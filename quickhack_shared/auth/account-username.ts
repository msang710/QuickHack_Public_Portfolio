export function normalizeAccountUsername(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}
