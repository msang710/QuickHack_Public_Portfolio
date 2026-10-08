// PrismaPg 7 misinterprets timestamptz values when the PostgreSQL session is not UTC.
// Keep existing connection options (notably test search_path) and apply UTC last.
export function prismaUtcConnectionString(connectionString) {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [existingOptions, "-c TimeZone=UTC"].filter(Boolean).join(" ")
  );
  return url.toString();
}
