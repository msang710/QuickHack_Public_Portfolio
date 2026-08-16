export function createPostgresqlBarrier(participantCount) {
  if (!Number.isSafeInteger(participantCount) || participantCount < 2) {
    throw new Error("PostgreSQL test barriers require at least two participants.");
  }
  let arrived = 0;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return async function waitAtBarrier() {
    arrived += 1;
    if (arrived === participantCount) release();
    await released;
  };
}
