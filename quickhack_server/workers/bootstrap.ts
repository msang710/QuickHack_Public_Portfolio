import {
  getRuntimeRole,
  type RuntimeRole,
} from "@/quickhack_shared/core/runtime";

type WorkerBootstrapEnvironment = {
  nextRuntime?: string;
  runtimeRole?: RuntimeRole;
};

export function shouldStartWorkerManagerForRuntime(
  environment: WorkerBootstrapEnvironment = {}
) {
  const nextRuntime = String(
    environment.nextRuntime ?? process.env.NEXT_RUNTIME ?? ""
  )
    .trim()
    .toLowerCase();
  const runtimeRole = environment.runtimeRole ?? getRuntimeRole();

  return nextRuntime === "nodejs" && runtimeRole !== "client";
}

export async function startWorkerManagerForRuntime() {
  if (!shouldStartWorkerManagerForRuntime()) {
    return null;
  }

  const { startWorkerManagerAndWaitForReady } = await import(
    "@/quickhack_server/workers/manager"
  );
  return startWorkerManagerAndWaitForReady();
}
