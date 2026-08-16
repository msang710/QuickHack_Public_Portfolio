export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { startWorkerManagerForRuntime } = await import(
    "@/quickhack_server/workers/bootstrap"
  );
  await startWorkerManagerForRuntime();
}
