import { spawn } from "node:child_process";
import path from "node:path";

export type ClientRuntimeHostOptions = Readonly<{
  appRoot: string;
  origin: string;
  nodeExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  childEnvironment?: Readonly<Record<string, string>>;
  runCommand?: (command: RuntimeCommand) => Promise<void>;
}>;

export type RuntimeCommand = "start" | "stop";

function run(options: ClientRuntimeHostOptions, command: RuntimeCommand): Promise<void> {
  const executable = options.nodeExecutable || process.env.QUICKHACK_NODE_EXECUTABLE || "node";
  const launcher = path.join(options.appRoot, "tools", "client-runtime-launcher.mjs");
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: options.environment?.NODE_ENV ?? process.env.NODE_ENV ?? "production",
  };
  for (const [name, value] of Object.entries(options.environment ?? process.env)) {
    if (typeof value === "string") environment[name] = value;
  }
  environment.QUICKHACK_DESKTOP_HOST = "1";
  Object.assign(environment, options.childEnvironment);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [launcher, command], {
      cwd: options.appRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Client runtime ${command} failed (${signal || code}): ${stderr.trim()}`));
    });
  });
}

export function createClientRuntimeHost(options: ClientRuntimeHostOptions) {
  let started = false;
  let operation: Promise<void> | null = null;
  const runCommand = options.runCommand ?? ((command: RuntimeCommand) => run(options, command));

  async function serialized(action: () => Promise<void>) {
    while (operation) await operation;
    const current = action();
    operation = current;
    try { await current; } finally { if (operation === current) operation = null; }
  }

  return Object.freeze({
    origin: options.origin,
    async start() {
      await serialized(async () => {
        if (started) return;
        await runCommand("start");
        started = true;
      });
    },
    async stop() {
      await serialized(async () => {
        if (!started) return;
        try { await runCommand("stop"); } finally { started = false; }
      });
    },
  });
}
