export function matchingBootstrapLeader(row, { requireTemporary = false } = {}) {
  return Boolean(
    row &&
    row.username === "admin" &&
    row.role === "LEADER" &&
    Number(row.is_active) === 1 &&
    (!requireTemporary || Number(row.must_change_password) === 1)
  );
}

export function planExistingBootstrapLeader(rows, { allowExistingLeaderAdoption = false } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("Bootstrap users must be an array.");
  if (rows.length === 0) return Object.freeze({ action: "CREATE" });
  if (rows.length !== 1 || !matchingBootstrapLeader(rows[0])) {
    return Object.freeze({ action: "CONFLICT" });
  }
  const userId = Number(rows[0].user_id);
  const credentialRevision = Number(rows[0].credential_revision);
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !Number.isSafeInteger(credentialRevision) ||
    credentialRevision < 0
  ) {
    return Object.freeze({ action: "CONFLICT" });
  }
  if (allowExistingLeaderAdoption) {
    return Object.freeze({
      action: "ADOPT",
      userId,
      generation: Math.max(1, credentialRevision),
    });
  }
  if (matchingBootstrapLeader(rows[0], { requireTemporary: true })) {
    return Object.freeze({
      action: "REISSUE",
      userId,
      generation: credentialRevision + 1,
    });
  }
  return Object.freeze({ action: "CONFLICT" });
}
