import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINUX_PACKAGE_TARGETS, linuxArtifactConfig } from "../../packaging/linux/linux-artifact-config.mjs";

const pkgbuild = readFileSync(new URL("../../packaging/linux/arch/PKGBUILD", import.meta.url), "utf8");
const installHook = readFileSync(new URL("../../packaging/linux/arch/quickhack-server.install", import.meta.url), "utf8");
const consoleUnit = readFileSync(new URL("../../packaging/linux/systemd/quickhack-console.service.in", import.meta.url), "utf8");
const postgresUnit = readFileSync(new URL("../../packaging/linux/systemd/quickhack-postgresql.service.in", import.meta.url), "utf8");

assert.deepEqual(LINUX_PACKAGE_TARGETS, ["demo-server", "demo-client", "operational-server", "operational-client"]);
const configs = LINUX_PACKAGE_TARGETS.map(linuxArtifactConfig);
assert.equal(new Set(configs.map((item) => item.installedIdentity)).size, 4);
assert.equal(new Set(configs.map((item) => item.applicationRoot)).size, 4);
for (const config of configs) assert.ok(pkgbuild.includes(config.installedIdentity));

assert.match(pkgbuild, /arch=\('x86_64'\)/);
assert.match(pkgbuild, /nodejs-lts-krypton>=24/);
assert.match(pkgbuild, /nodejs-lts-krypton<25/);
assert.match(pkgbuild, /postgresql>=18/);
assert.match(pkgbuild, /postgresql<19/);
assert.match(pkgbuild, /android-tools/);
assert.match(pkgbuild, /cups/);
assert.match(pkgbuild, /conflicts=\('quickhack-operational-server'\)/);
assert.match(pkgbuild, /conflicts=\('quickhack-demonstration-server'\)/);
assert.doesNotMatch(pkgbuild, /depends=.*postgresql.*package_quickhack-(?:demonstration|operational)-client/u);

assert.match(installHook, /systemd-sysusers/);
assert.match(installHook, /systemd-tmpfiles --create/);
assert.match(installHook, /systemctl daemon-reload/);
assert.doesNotMatch(installHook, /systemctl (?:start|enable)|quickhack-operator/u);
assert.match(consoleUnit, /ExecStart=.*QUICKHACK_CONSOLE_ENTRY/);
assert.match(consoleUnit, /--package-manifest @QUICKHACK_PACKAGE_MANIFEST@/);
assert.match(consoleUnit, /User=@QUICKHACK_APPLICATION_USER@/);
assert.doesNotMatch(consoleUnit, /User=root/);
assert.match(postgresUnit, /ExecStart=@QUICKHACK_POSTGRES_EXECUTABLE@/);
assert.doesNotMatch(`${pkgbuild}\n${postgresUnit}`, /\/var\/lib\/postgres\/data|postgresql\.service/u);

console.log("Arch four-way split package metadata and systemd ownership verified.");
