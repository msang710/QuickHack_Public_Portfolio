import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  dependencyInvalid,
  dependencyMissing,
} from "../../../quickhack_shared/platform/platform-capability-error.mjs";
import {
  createLinuxChildProcessPolicy,
  resolveLinuxSystemExecutable,
} from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";
import type {
  AdbExecutableResolver,
  ClientNativeExecutionContext,
} from "../contracts.ts";

const execFileAsync = promisify(execFileCallback);
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER = 256 * 1024;
const ADB_VERSION_PATTERN = /Android Debug Bridge version/i;

type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

type ResolverDependencies = Readonly<{
  executeFile?: ExecuteFile;
  lstatFile?: typeof lstat;
  accessFile?: typeof access;
}>;

function absoluteLinuxPath(value: string, field: string) {
  const source = String(value ?? "").trim();
  if (!path.posix.isAbsolute(source) || source.split("/").includes("..")) {
    throw new TypeError(`${field} must be an absolute Linux path.`);
  }
  return path.posix.normalize(source);
}

function candidates(input: ClientNativeExecutionContext) {
  const appRoot = absoluteLinuxPath(input.appRoot, "appRoot");
  const runtimeDir = absoluteLinuxPath(input.runtimeDir, "runtimeDir");
  return {
    appRoot,
    values: [
      path.posix.join(runtimeDir, "platform-tools", "adb"),
      path.posix.join(runtimeDir, "adb", "adb"),
      path.posix.join(appRoot, "platform-tools", "adb"),
      resolveLinuxSystemExecutable("adb"),
    ].filter((value, index, values) => values.indexOf(value) === index),
  };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function versionText(value: string | Buffer | undefined) {
  return String(value ?? "").trim().slice(0, 512);
}

export function createLinuxAdbExecutableResolver(
  dependencies: ResolverDependencies = {}
): AdbExecutableResolver {
  const executeFile = dependencies.executeFile ?? (execFileAsync as ExecuteFile);
  const inspectFile = dependencies.lstatFile ?? lstat;
  const checkAccess = dependencies.accessFile ?? access;
  let cached: Readonly<{ key: string; plan: Awaited<ReturnType<AdbExecutableResolver["resolve"]>> }> | null = null;

  return Object.freeze({
    descriptor: Object.freeze({
      id: "adb-executable-resolver",
      role: "client",
      platform: "linux",
      state: "READY",
      ownerStage: "PR-07",
    }),
    async resolve(input) {
      const candidateSet = candidates(input);
      const cacheKey = `${candidateSet.appRoot}\0${absoluteLinuxPath(
        input.runtimeDir,
        "runtimeDir"
      )}`;
      if (cached?.key === cacheKey) return cached.plan;
      let invalidCandidateObserved = false;

      for (const executable of candidateSet.values) {
        try {
          const state = await inspectFile(executable);
          if (!state.isFile() || state.isSymbolicLink()) {
            invalidCandidateObserved = true;
            continue;
          }
          await checkAccess(executable, constants.X_OK);
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) continue;
          invalidCandidateObserved = true;
          continue;
        }

        const environment = createChildProcessEnvironment({
          policy: createLinuxChildProcessPolicy(input.environment ?? {}),
          source: input.environment ?? {},
          executableDirectories: [path.posix.dirname(executable)],
          overrides: { LC_ALL: "C", LANG: "C" },
        });
        try {
          const result = await executeFile(executable, ["version"], {
            cwd: candidateSet.appRoot,
            encoding: "utf8",
            timeout: VERSION_TIMEOUT_MS,
            maxBuffer: VERSION_MAX_BUFFER,
            env: environment,
          });
          const observedVersion = `${versionText(result.stdout)}\n${versionText(
            result.stderr
          )}`.trim();
          if (!ADB_VERSION_PATTERN.test(observedVersion)) {
            invalidCandidateObserved = true;
            continue;
          }
          const plan = Object.freeze({
            executable,
            cwd: candidateSet.appRoot,
            environment: Object.freeze({ ...environment }),
            observedVersion: observedVersion.split(/\r?\n/u)[0],
          });
          cached = Object.freeze({ key: cacheKey, plan });
          return plan;
        } catch {
          invalidCandidateObserved = true;
        }
      }

      if (invalidCandidateObserved) {
        throw dependencyInvalid({
          role: "client",
          capability: "adb-executable-resolver",
          platform: "linux",
          dependency: "adb",
          recovery: "Install or repair ADB at an approved QuickHack runtime path.",
          message: "The configured QuickHack ADB executable is invalid.",
        });
      }
      throw dependencyMissing({
        role: "client",
        capability: "adb-executable-resolver",
        platform: "linux",
        dependency: "adb",
        recovery: "Install ADB at /usr/bin/adb or repair the QuickHack client runtime.",
        message: "QuickHack could not find an approved ADB executable.",
      });
    },
  });
}

export const linuxAdbExecutableResolver = createLinuxAdbExecutableResolver();
