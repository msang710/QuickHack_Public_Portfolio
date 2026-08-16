type ErrorRecord = Record<string, unknown>;

const RETRYABLE_SQL_STATES = new Set(["40001", "40P01"]);

function errorRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === "object" ? (value as ErrorRecord) : null;
}

function stringField(record: ErrorRecord | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorChain(error: unknown) {
  const queue = [error];
  const seen = new Set<unknown>();
  const records: ErrorRecord[] = [];

  while (queue.length > 0 && records.length < 12) {
    const current = queue.shift();
    const record = errorRecord(current);
    if (!record || seen.has(current)) continue;
    seen.add(current);
    records.push(record);

    for (const nested of [
      record.cause,
      errorRecord(record.meta)?.driverAdapterError,
      errorRecord(record.meta)?.cause,
      errorRecord(record.driverAdapterError)?.cause,
    ]) {
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }

  return records;
}

export function prismaErrorCode(error: unknown) {
  for (const record of errorChain(error)) {
    const code = stringField(record, "code");
    if (
      code &&
      /^P\d{4}$/.test(code) &&
      stringField(record, "severity") === null
    ) {
      return code;
    }
  }
  return null;
}

export function postgresqlSqlState(error: unknown) {
  for (const record of errorChain(error)) {
    for (const key of ["sqlState", "sqlstate", "originalCode"]) {
      const value = stringField(record, key)?.toUpperCase();
      if (value && /^[0-9A-Z]{5}$/.test(value)) {
        return value;
      }
    }

    const code = stringField(record, "code")?.toUpperCase();
    if (
      code &&
      /^[0-9A-Z]{5}$/.test(code) &&
      (!/^P\d{4}$/.test(code) || stringField(record, "severity") !== null)
    ) {
      return code;
    }
  }
  return null;
}

function constraintFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const fields = value.filter((item): item is string => typeof item === "string");
    return fields.length > 0 ? fields.join(",") : null;
  }
  const record = errorRecord(value);
  if (!record) return null;
  return (
    stringField(record, "index") ??
    stringField(record, "constraint") ??
    stringField(record, "foreignKey")
  );
}

function postgresqlConstraintNames(error: unknown) {
  const directConstraints: string[] = [];
  const targets: string[] = [];

  for (const record of errorChain(error)) {
    const direct =
      constraintFromValue(record.constraint) ??
      constraintFromValue(record.index) ??
      constraintFromValue(errorRecord(record.meta)?.constraint) ??
      constraintFromValue(errorRecord(record.cause)?.constraint);
    if (direct) directConstraints.push(direct);

    const target =
      constraintFromValue(record.target) ??
      constraintFromValue(errorRecord(record.meta)?.target);
    if (target) targets.push(target);
  }

  return [...new Set([...directConstraints, ...targets])];
}

export function postgresqlConstraintName(error: unknown) {
  return postgresqlConstraintNames(error)[0] ?? null;
}

export function isPostgresqlUniqueViolation(error: unknown) {
  return prismaErrorCode(error) === "P2002" || postgresqlSqlState(error) === "23505";
}

export function isPostgresqlForeignKeyViolation(error: unknown) {
  return prismaErrorCode(error) === "P2003" || postgresqlSqlState(error) === "23503";
}

export function isExpectedPostgresqlUniqueViolation(
  error: unknown,
  expectedConstraints: readonly string[]
) {
  if (!isPostgresqlUniqueViolation(error)) return false;
  return postgresqlConstraintNames(error).some((constraint) =>
    expectedConstraints.includes(constraint)
  );
}

export function isRetryablePostgresqlTransactionError(error: unknown) {
  const sqlState = postgresqlSqlState(error);
  if (sqlState && RETRYABLE_SQL_STATES.has(sqlState)) return true;

  // Prisma's driver adapter intentionally folds PostgreSQL serialization
  // failures and deadlocks into P2034. No other Prisma code is retryable here.
  return prismaErrorCode(error) === "P2034";
}

