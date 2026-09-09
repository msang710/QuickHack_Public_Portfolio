import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, "quickhack_client/i18n/hardcoded-ui-baseline.json");
// mock_server is deliberately outside this list: it reproduces provider-owned
// payloads and popup surfaces. The exclusion is asserted by the namespace
// ownership contract; QuickHack-authored UI and public API code remain covered.
const SOURCE_ROOTS = ["app", "quickhack_client", "quickhack_desktop", "quickhack_server", "quickhack_shared", "tools"];
const USER_FACING_PROPS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "caption",
  "description",
  "emptyMessage",
  "error",
  "helperText",
  "label",
  "message",
  "placeholder",
  "successMessage",
  "title",
  "tooltip",
]);
const USER_FACING_CALLS = new Set([
  "alert",
  "confirm",
  "prompt",
  "showErrorBox",
  "setError",
  "setMessage",
  "setNotice",
  "setStatusMessage",
  "setSuccessMessage",
  "toast",
]);
const SERVER_USER_FACING_CALLS = new Set([
  "publicBadRequest",
  "publicConflict",
  "publicForbidden",
  "publicNotFound",
  "publicUnavailable",
  "inputError",
  "inventoryInputError",
  "inventoryAuditInputError",
  "inboundBatchInputError",
  "changedPrecondition",
]);
const SERVER_RENDERED_DTO_PROPS = new Set([
  "unavailableReason",
  "warnings",
]);
const SERVER_USER_FACING_ERROR_CONSTRUCTORS = new Set([
  "AccountProfileUpdateError",
  "CarrierInvoiceIssueError",
  "CarrierInvoiceReplacementError",
  "InboundReconciliationInputError",
  "InventoryQuantityQueryInputError",
  "MobileDeviceAuthError",
  "PasswordChangeError",
  "PersonalSettingsValidationError",
  "RegistrationBlockedError",
  "ShipmentDeliverySearchNotFoundError",
  "ShipmentDeliverySearchValidationError",
  "TotpSecurityRecoveryError",
  "RuntimeSettingsTransitionError",
]);
const fixtureArgumentIndex = process.argv.indexOf("--fixture");
const fixtureScopeArgumentIndex = process.argv.indexOf("--fixture-scope");
const fixtureScope =
  fixtureScopeArgumentIndex >= 0
    ? process.argv[fixtureScopeArgumentIndex + 1]
    : null;
if (fixtureScope && !["api", "server", "ui"].includes(fixtureScope)) {
  console.error("--fixture-scope must be api, server, or ui.");
  process.exit(2);
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolute);
    return /\.(?:mjs|mts|ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function normalizedText(value) {
  return value.replace(/\s+/gu, " ").trim();
}

const LOCALE_NEUTRAL_UI_LITERALS = new Set([
  "ADB",
  "ADB Serial",
  "ADB serial",
  "API",
  "DB",
  "DELETE",
  "ERP/WMS",
  "GET",
  "HEAD",
  "IMEI",
  "N",
  "No",
  "OTP",
  "PATCH",
  "PG",
  "Prisma schema",
  "POST",
  "PUT",
  "QuickHack",
  "Trace ID",
  "Y",
  "Y/N",
  "vendorItemId",
  "worker",
  "worker manager",
  "_prisma_migrations",
  "leader / manager / staff / viewer",
  "QuickHack!234",
  "rev",
  "rev.",
  "pg",
  "· IMEI",
  "-&gt;",
]);

function localeNeutralLiteral(value) {
  const text = normalizedText(value);
  const staticText = text.replace(/\$\{[^}]+\}/gu, "").trim();
  return (
    !staticText ||
    LOCALE_NEUTRAL_UI_LITERALS.has(staticText) ||
    /^[A-Z][A-Z0-9_]*$/u.test(staticText) ||
    /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u.test(staticText) ||
    /^[\d\s#@%./:|~+·•–—←→🥳🎉🎁-]+$/u.test(staticText) ||
    /^(?:AA0+|S24-345|YYYY-MM-DD|\/api\/\.\.\.)$/u.test(staticText)
  );
}

function location(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: path.relative(ROOT, sourceFile.fileName).split(path.sep).join("/"),
    line: start.line + 1,
    column: start.character + 1,
  };
}

function candidate(sourceFile, node, kind, rawValue, detail = null) {
  const text = normalizedText(rawValue);
  if (!text || localeNeutralLiteral(text)) return null;
  return { ...location(sourceFile, node), kind, detail, text };
}

function candidateAt(sourceFile, offset, kind, rawValue, detail = null) {
  const text = normalizedText(rawValue);
  if (!text || localeNeutralLiteral(text)) return null;
  const start = sourceFile.getLineAndCharacterOfPosition(offset);
  return {
    file: path.relative(ROOT, sourceFile.fileName).split(path.sep).join("/"),
    line: start.line + 1,
    column: start.character + 1,
    kind,
    detail,
    text,
  };
}

function templateStaticText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return node.getText();
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
}

function apiMessageCandidate(sourceFile, node, rawValue, options = {}) {
  const text = normalizedText(rawValue);
  if (!text) return null;
  if (options.koreanOnly && !/[\uac00-\ud7a3]/u.test(text)) return null;
  return { ...location(sourceFile, node), kind: "api-message", detail: "message", text };
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function scanFile(fileName, scope = fixtureScope) {
  const source = fs.readFileSync(fileName, "utf8");
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found = [];
  const relativeFile = path.relative(ROOT, fileName).split(path.sep).join("/");
  const serviceSource = scope
    ? scope === "server"
    : (relativeFile.startsWith("quickhack_server/") &&
        !relativeFile.startsWith("quickhack_server/api/")) ||
      relativeFile.startsWith("quickhack_shared/") ||
      relativeFile.startsWith("tools/");
  const apiRoute = scope
    ? scope === "api"
    : relativeFile.startsWith("quickhack_server/api/") ||
      relativeFile.startsWith("app/api/") ||
      (source.includes('from "next/server"') && source.includes("NextResponse"));

  function add(value) {
    if (value) found.push(value);
  }

  function addServerRenderedDtoLiterals(node, detail) {
    if (ts.isStringLiteralLike(node)) {
      add(apiMessageCandidate(sourceFile, node, node.text, { koreanOnly: true }));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      add(apiMessageCandidate(sourceFile, node, templateStaticText(node), { koreanOnly: true }));
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        addServerRenderedDtoLiterals(element, detail);
      }
    }
  }

  if (fileName.endsWith(".mjs") && source.includes("<")) {
    for (const match of source.matchAll(/\b(aria-label|placeholder|title)="([^"$]*)"/gu)) {
      add(candidateAt(sourceFile, match.index, "html-attribute", match[2], match[1]));
    }
    for (const match of source.matchAll(/<[a-z][^>]*>([^<>{}$]*[A-Za-z\uac00-\ud7a3][^<>{}$]*)<\/[a-z]/giu)) {
      add(candidateAt(sourceFile, match.index, "html-text", match[1]));
    }
  }

  function visit(node) {
    if (!serviceSource && ts.isJsxText(node)) {
      add(candidate(sourceFile, node, "jsx-text", node.getText(sourceFile)));
    } else if (!serviceSource && ts.isJsxAttribute(node)) {
      const name = propertyName(node.name);
      if (name && USER_FACING_PROPS.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          add(candidate(sourceFile, node.initializer, "jsx-prop", node.initializer.text, name));
        } else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          (ts.isStringLiteral(node.initializer.expression) || ts.isNoSubstitutionTemplateLiteral(node.initializer.expression))
        ) {
          add(candidate(sourceFile, node.initializer.expression, "jsx-prop", node.initializer.expression.text, name));
        }
      }
    } else if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const monitoredCall =
        name &&
        (serviceSource
          ? SERVER_USER_FACING_CALLS.has(name)
          : USER_FACING_CALLS.has(name));
      if (monitoredCall) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
            add(candidate(sourceFile, argument, "ui-call", argument.text, name));
          } else if (ts.isTemplateExpression(argument)) {
            add(candidate(sourceFile, argument, "ui-template", templateStaticText(argument), name));
          }
        }
      }
    } else if (
      serviceSource &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SERVER_USER_FACING_ERROR_CONSTRUCTORS.has(node.expression.text)
    ) {
      for (const argument of node.arguments ?? []) {
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          add(candidate(sourceFile, argument, "server-public-error", argument.text, node.expression.text));
        } else if (ts.isTemplateExpression(argument)) {
          add(candidate(sourceFile, argument, "server-public-error-template", templateStaticText(argument), node.expression.text));
        }
      }
    } else if (
      apiRoute &&
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === "message"
    ) {
      add(apiMessageCandidate(sourceFile, node, node.getText(sourceFile)));
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (
        serviceSource &&
        (name === "message" || name === "errorMessage") &&
        !(ts.isCallExpression(node.initializer) && callName(node.initializer.expression) === "preserveKoreanSnapshot")
      ) {
        const value = node.initializer;
        add(apiMessageCandidate(sourceFile, value, ts.isTemplateExpression(value) ? value.getText(sourceFile) : ts.isStringLiteralLike(value) ? value.text : value.getText(sourceFile), { koreanOnly: true }));
      } else if (serviceSource && name && SERVER_RENDERED_DTO_PROPS.has(name)) {
        addServerRenderedDtoLiterals(node.initializer, name);
      } else if (!serviceSource && name && USER_FACING_PROPS.has(name)) {
        const value = node.initializer;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          add(
            apiRoute && name === "message"
              ? apiMessageCandidate(sourceFile, value, value.text)
              : candidate(sourceFile, value, "object-prop", value.text, name)
          );
        } else if (ts.isTemplateExpression(value)) {
          add(
            apiRoute && name === "message"
              ? apiMessageCandidate(sourceFile, value, value.getText(sourceFile))
              : candidate(sourceFile, value, "object-template", templateStaticText(value), name)
          );
        } else if (apiRoute && name === "message") {
          add(apiMessageCandidate(sourceFile, value, value.getText(sourceFile)));
        }
      }
    } else if (
      serviceSource &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      (node.left.text === "message" || node.left.text === "errorMessage") &&
      !(ts.isCallExpression(node.right) && callName(node.right.expression) === "preserveKoreanSnapshot")
    ) {
      add(apiMessageCandidate(sourceFile, node.right, ts.isTemplateExpression(node.right) ? node.right.getText(sourceFile) : ts.isStringLiteralLike(node.right) ? node.right.text : node.right.getText(sourceFile), { koreanOnly: true }));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function fingerprint(entry) {
  return `${entry.file}:${entry.kind}:${entry.detail ?? ""}:${entry.text}:${entry.occurrence ?? 1}`;
}

export function scanI18nFiles(fileNames, scope = null) {
  const sortedEntries = fileNames
    .map((fileName) => path.resolve(ROOT, fileName))
    .filter((fileName) => !fileName.includes(`${path.sep}i18n${path.sep}catalogs${path.sep}`))
    .flatMap((fileName) => scanFile(fileName, scope))
    .sort((left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.kind.localeCompare(right.kind)
    );
  const occurrences = new Map();
  return sortedEntries.map((entry) => {
    const key = `${entry.file}:${entry.kind}:${entry.detail ?? ""}:${entry.text}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return { ...entry, occurrence };
  });
}

const runningAsCli =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (runningAsCli) {
const fixtureFiles = fixtureArgumentIndex >= 0
  ? process.argv
      .slice(fixtureArgumentIndex + 1)
      .filter((value, index, values) => {
        if (value.startsWith("--")) return false;
        return values[index - 1] !== "--fixture-scope";
      })
  : null;
if (fixtureFiles && fixtureFiles.length === 0) {
  console.error("--fixture requires at least one TypeScript or TSX file.");
  process.exit(2);
}

const inputFiles = fixtureFiles
  ? fixtureFiles.map((fileName) => path.resolve(ROOT, fileName))
  : SOURCE_ROOTS.flatMap((root) => walkFiles(path.join(ROOT, root)));
const current = scanI18nFiles(inputFiles, fixtureScope);

if (fixtureFiles) {
  process.stdout.write(`${JSON.stringify({ version: 1, entries: current }, null, 2)}\n`);
  process.exit(0);
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ version: 1, entries: current }, null, 2)}\n`);
  process.exit(0);
}

if (process.argv.includes("--write-baseline")) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ version: 1, generatedBy: "tools/check-i18n-ui-strings.mjs", entries: current }, null, 2)}\n`
  );
  console.log(`Wrote ${current.length} UI string candidates to ${path.relative(ROOT, BASELINE_PATH)}.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(`Missing baseline: ${path.relative(ROOT, BASELINE_PATH)}. Run with --write-baseline after review.`);
  process.exit(2);
}

const baselineDocument = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
if (baselineDocument.version !== 1 || !Array.isArray(baselineDocument.entries)) {
  console.error("Invalid hardcoded UI baseline contract.");
  process.exit(2);
}

const baseline = new Set(baselineDocument.entries.map(fingerprint));
const currentSet = new Set(current.map(fingerprint));
const introduced = current.filter((entry) => !baseline.has(fingerprint(entry)));
const removed = baselineDocument.entries.filter((entry) => !currentSet.has(fingerprint(entry)));

console.log(`Hardcoded UI strings: current=${current.length} baseline=${baseline.size} removed=${removed.length} introduced=${introduced.length}`);
if (introduced.length) {
  for (const entry of introduced.slice(0, 100)) {
    console.error(`${entry.file}:${entry.line}:${entry.column} [${entry.kind}${entry.detail ? `:${entry.detail}` : ""}] ${entry.text}`);
  }
  if (introduced.length > 100) console.error(`... ${introduced.length - 100} more`);
  process.exit(1);
}
}
