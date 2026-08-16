import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }

    if (!specifier.startsWith("@/")) {
      return nextResolve(specifier, context);
    }

    const basePath = path.resolve(projectRoot, specifier.slice(2));
    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, "index.ts"),
      path.join(basePath, "index.tsx"),
    ];
    const resolvedPath = candidates.find((candidate) => existsSync(candidate));

    if (!resolvedPath) {
      return nextResolve(specifier, context);
    }

    return nextResolve(pathToFileURL(resolvedPath).href, context);
  },
});
