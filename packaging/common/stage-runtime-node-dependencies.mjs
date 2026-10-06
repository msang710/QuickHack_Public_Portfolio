import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

function packageSegments(name) {
  if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") {
    throw new TypeError(`Invalid runtime package name: ${name}`);
  }
  return name.split("/");
}

function findPackage(sourceRoot, importer, name) {
  const segments = packageSegments(name);
  for (let directory = importer; directory.startsWith(sourceRoot); directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", ...segments);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (directory === sourceRoot) break;
  }
  return null;
}

export function stageRuntimeNodeDependencies({ sourceRoot, destinationRoot, packages }) {
  const root = realpathSync(sourceRoot);
  const modulesRoot = path.join(root, "node_modules");
  const destinationModules = path.join(path.resolve(destinationRoot), "node_modules");
  if (!Array.isArray(packages) || packages.length === 0) throw new TypeError("Runtime package roots are required.");
  const pending = packages.map((name) => ({ name, importer: root, optional: false }));
  const staged = new Set();
  while (pending.length) {
    const { name, importer, optional } = pending.pop();
    const source = findPackage(root, importer, name);
    if (!source) {
      if (optional) continue;
      throw new Error(`Required runtime package is missing: ${name}`);
    }
    const relative = path.relative(modulesRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(source).isDirectory()) {
      throw new Error(`Runtime package path escaped node_modules: ${name}`);
    }
    if (staged.has(relative)) continue;
    staged.add(relative);
    const metadata = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
    if (metadata.name !== name) throw new Error(`Runtime package name mismatch: ${name}`);
    const destination = path.join(destinationModules, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true, dereference: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) pending.push({ name: dependency, importer: source, optional: false });
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) pending.push({ name: dependency, importer: source, optional: true });
  }
  return Object.freeze([...staged].sort());
}
