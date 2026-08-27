import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, ".quickhack-electron");

await rm(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    main: "quickhack_desktop/main.ts",
    preload: "quickhack_desktop/preload.ts",
  },
  outdir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
});
