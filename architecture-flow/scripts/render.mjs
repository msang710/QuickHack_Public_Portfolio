import { createServer } from "node:http";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectDirectory = resolve(
  fileURLToPath(new URL("..", import.meta.url))
);
const distDirectory = join(projectDirectory, "dist");
const outputDirectory = join(projectDirectory, "output");
const browserExecutableCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function safeFilePath(urlPath) {
  const requested = decodeURIComponent(urlPath.split("?")[0] || "/");
  const relativePath = requested === "/" ? "index.html" : requested.slice(1);
  const candidate = normalize(join(distDirectory, relativePath));

  if (!candidate.startsWith(distDirectory)) {
    return join(distDirectory, "index.html");
  }

  return candidate;
}

const server = createServer(async (request, response) => {
  let filePath = safeFilePath(request.url || "/");

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
  } catch {
    filePath = join(distDirectory, "index.html");
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type":
        contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Render server error");
  }
});

await mkdir(outputDirectory, { recursive: true });

await new Promise((resolveServer, rejectServer) => {
  server.once("error", rejectServer);
  server.listen(0, "127.0.0.1", resolveServer);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to start the local render server.");
}

let browserExecutablePath;
for (const candidate of browserExecutableCandidates) {
  try {
    await access(candidate);
    browserExecutablePath = candidate;
    break;
  } catch {
    // Try the next locally installed Chromium browser.
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutablePath,
});
const diagrams = [
  { id: "overview", outputName: "quickhack-system-architecture" },
  { id: "code-structure", outputName: "quickhack-code-structure" },
  { id: "business-data-flow", outputName: "quickhack-business-data-flow" },
  { id: "safe-external-write", outputName: "quickhack-safe-external-write" },
  { id: "worker-recovery", outputName: "quickhack-worker-recovery" },
  { id: "core-data-model", outputName: "quickhack-core-data-model" },
];
const resolutions = [{ suffix: "1920x1080", deviceScaleFactor: 1 }];
const renderTheme =
  process.env.RENDER_THEME === "blueprint" ? "blueprint" : "default";
const requestedDiagramIds = new Set(
  (process.env.DIAGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const selectedDiagrams =
  requestedDiagramIds.size === 0
    ? diagrams
    : diagrams.filter((diagram) => requestedDiagramIds.has(diagram.id));

if (selectedDiagrams.length === 0) {
  throw new Error(
    `No matching diagrams for DIAGRAM_IDS=${process.env.DIAGRAM_IDS}`
  );
}

const renderTargets = selectedDiagrams.flatMap((diagram) =>
  resolutions.map((resolution) => ({
    ...diagram,
    ...resolution,
    name: `${diagram.outputName}${
      renderTheme === "default" ? "" : `-${renderTheme}`
    }-${resolution.suffix}.png`,
  }))
);

try {
  for (const target of renderTargets) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: target.deviceScaleFactor,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(message.text());
      }
    });

    await page.goto(
      `http://127.0.0.1:${address.port}?diagram=${encodeURIComponent(
        target.id
      )}&theme=${encodeURIComponent(renderTheme)}`,
      {
        waitUntil: "networkidle",
      }
    );
    await page.waitForSelector('[data-render-ready="true"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);

    const renderState = await page.evaluate(() => {
      const root = document.querySelector(
        ".portfolio-page[data-render-ready='true']"
      );
      const canvas = document.querySelector(".architecture-canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      const outOfBoundsNodes = Array.from(
        document.querySelectorAll(".react-flow__node")
      )
        .filter((element) => {
          if (!canvasRect) return true;
          const rect = element.getBoundingClientRect();
          return (
            rect.left < canvasRect.left ||
            rect.top < canvasRect.top ||
            rect.right > canvasRect.right ||
            rect.bottom > canvasRect.bottom
          );
        })
        .map((element) => element.getAttribute("data-id"));

      return {
        diagramId: root?.getAttribute("data-diagram-id"),
        renderTheme: root?.getAttribute("data-render-theme"),
        expectedNodes: Number(root?.getAttribute("data-expected-nodes")),
        expectedEdges: Number(root?.getAttribute("data-expected-edges")),
        nodes: document.querySelectorAll(".react-flow__node").length,
        edges: document.querySelectorAll(".react-flow__edge").length,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        outOfBoundsNodes,
      };
    });

    if (
      runtimeErrors.length > 0 ||
      renderState.diagramId !== target.id ||
      renderState.renderTheme !== renderTheme ||
      renderState.nodes !== renderState.expectedNodes ||
      renderState.edges !== renderState.expectedEdges ||
      renderState.outOfBoundsNodes.length > 0 ||
      renderState.width !== 1920 ||
      renderState.height !== 1080
    ) {
      throw new Error(
        JSON.stringify({ runtimeErrors, renderState }, null, 2)
      );
    }

    await page.screenshot({
      path: join(outputDirectory, target.name),
      fullPage: false,
    });

    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(
  renderTargets
    .map((target) => join(outputDirectory, target.name))
    .join("\n")
);
