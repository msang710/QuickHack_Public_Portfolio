import assert from "node:assert/strict";
import vm from "node:vm";
import { renderServerConsolePage } from "../../tools/server-console-core.mjs";
import { serverConsoleMessages } from "../../tools/server-console-i18n.mjs";
import { demonstrationConsoleIntegration } from "../../tools/server-console-demonstration.mjs";
import { operationalConsoleIntegration } from "../../tools/server-console-operational.mjs";

for (const integration of [demonstrationConsoleIntegration, operationalConsoleIntegration]) {
  for (const locale of ["ko", "en"]) {
    for (const view of ["/", "/api-key-management", "/database-management"]) {
      const html = renderServerConsolePage({
        flavor: integration.flavor,
        actionToken: "layout-test-token",
        integrationHtml: integration.renderHtml(serverConsoleMessages(locale)),
        locale,
        view,
      });
      assert.match(html, /--bg: #f6f7f9/u);
      assert.match(html, /href="\/api-key-management"/u);
      assert.match(html, /href="\/database-management"/u);
      assert.match(html, /data-panel="quickhack-keys"/u);
      assert.match(html, /data-server="backend"/u);
      assert.match(html, /data-server="gateway"/u);
      assert.match(html, /id="clock-kst"/u);
      assert.match(html, /id="path-runtime-config"/u);
      assert.match(html, /id="logs"/u);
      assert.match(html, /\/api\/logs\?after=/u);
      assert.match(html, /\/api\/servers\/" \+ button\.dataset\.serverId/u);
      const selectedPanel = view === "/" ? "panel-servers" : view === "/api-key-management" ? "panel-api-keys" : "panel-backups";
      for (const panel of ["panel-servers", "panel-api-keys", "panel-backups"]) {
        const openingTag = html.match(new RegExp(`<main id="${panel}"[^>]*>`))?.[0];
        assert(openingTag, `Missing ${panel}`);
        assert.equal(openingTag.includes(" hidden"), panel !== selectedPanel);
      }
      assert.equal(html.includes('data-server="coupang-simulator"'), integration.flavor === "DEMONSTRATION");
      assert.equal(html.includes('id="coupang-key-form"'), integration.flavor === "OPERATIONAL");
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]));
      for (const [, id] of html.matchAll(/\$\("([^"]+)"\)/gu)) {
        assert(ids.has(id), `The console script references a missing element: ${id}`);
      }
      for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].entries()) {
        new vm.Script(match[1], { filename: `${integration.flavor}-${locale}-${view}-${index}.js` });
      }
    }
  }
}

console.log("Both server console layouts and embedded scripts verified.");
