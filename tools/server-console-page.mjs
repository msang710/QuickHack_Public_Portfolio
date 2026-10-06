// Restored from the prior Windows server-console.mjs UI (SHA-256 ed77a00585835246dab8ed19c2e7b6c9202995277cc0bc741af8f996d1049a94).
import {
  formatServerConsoleMessage,
  serverConsoleActionMessages,
  serverConsoleMessages,
} from "./server-console-i18n.mjs";

const PORTS = { backend: 3000, gateway: 3443, coupang: 3100, logen: 3200 };

export function renderRestoredServerConsolePage({
  flavor,
  actionToken,
  integrationHtml,
  locale,
  view = "/",
}) {
  const t = serverConsoleMessages(locale);
  const actionMessages = serverConsoleActionMessages(locale);
  const isMain = view === "/";
  const isKeys = view === "/api-key-management";
  const isBackups = view === "/database-management";
  const servers = [
    ["backend", t.backendServer, PORTS.backend],
    ["gateway", t.gatewayServer, PORTS.gateway],
    ...(flavor === "DEMONSTRATION"
      ? [
          ["coupang-simulator", t.coupangServer, PORTS.coupang],
          ["logen-simulator", t.logenServer, PORTS.logen],
        ]
      : []),
  ];
  const serviceCards = servers.map(([id, label, port]) => `
    <div class="service" data-server="${id}">
      <div class="service-head">
        <div><div class="name">${label}</div><div class="meta">:${port} · <span class="server-detail">${t.checking}</span></div></div>
        <span class="pill off server-state">${t.checking}</span>
      </div>
      <div class="buttons">
        <button class="primary" data-server-id="${id}" data-server-action="start">${t.start}</button>
        <button class="danger" data-server-id="${id}" data-server-action="stop">${t.stop}</button>
      </div>
    </div>`).join("");
  const logTabs = [
    ["application", "QuickHack"],
    ...(flavor === "DEMONSTRATION"
      ? [["coupang-simulator", "Coupang Mock"], ["logen-simulator", "로젠택배 Mock"]]
      : []),
    ["supervisor", "Console"],
    ["", t.allServers],
  ].map(([id, label], index) =>
    `<button data-log="${id}" class="${index === 0 ? "active" : ""}">${label}</button>`
  ).join("");

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t.title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #fff;
      --line: #d8dde6;
      --text: #151922;
      --muted: #667085;
      --brand: #0f766e;
      --danger: #b42318;
      --warn: #b54708;
      --ok: #067647;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px "Segoe UI", "Malgun Gothic", Arial, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 18px; }
    h2 { margin: 0; font-size: 15px; }
    main { padding: 16px; }
    .dashboard { display: grid; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); gap: 16px; min-height: calc(100vh - 70px); }
    .detail-layout { max-width: 1060px; margin: auto; display: grid; gap: 16px; }
    .key-layout { max-width: 1180px; grid-template-columns: minmax(360px, 1fr) minmax(420px, 1.15fr); align-content: start; }
    .key-layout #panel-quickhack-keys, .key-layout #key-message { grid-column: 1 / -1; }
    .stack { display: grid; gap: 12px; align-content: start; }
    section { min-width: 0; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; overflow: hidden; }
    section.card { padding: 14px; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); font-weight: 700; }
    .content { padding: 14px; }
    .service { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .service-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .name { font-weight: 700; }
    .meta, .muted { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .pill { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .pill.ok { color: var(--ok); background: #ecfdf3; border-color: #abefc6; }
    .pill.off { color: var(--muted); background: #f2f4f7; }
    .pill.warn { color: var(--warn); background: #fffaeb; border-color: #fedf89; }
    .buttons, nav, .tabs { display: flex; flex-wrap: wrap; gap: 8px; }
    button, a.button, input { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit; }
    button, a.button { background: #fff; color: var(--text); cursor: pointer; text-decoration: none; }
    button.primary { background: var(--brand); color: #fff; border-color: var(--brand); }
    button.danger { color: var(--danger); border-color: #fecdca; }
    button.toggle-button { font-weight: 700; }
    button.toggle-button.on { color: var(--ok); background: #ecfdf3; border-color: #abefc6; }
    button.toggle-button.production { color: var(--warn); background: #fffaeb; border-color: #fedf89; }
    button.toggle-button.blocked { color: var(--danger); background: #fef3f2; border-color: #fecdca; }
    button:disabled { cursor: wait; opacity: .6; }
    a.button.active, .tabs button.active { background: #111827; color: #fff; border-color: #111827; }
    input { min-width: 180px; max-width: 100%; }
    form { display: grid; gap: 9px; margin-top: 12px; }
    dl { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 8px 10px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .tabs { padding: 10px 14px 0; }
    #logs { margin: 0; height: calc(100vh - 190px); min-height: 360px; overflow: auto; padding: 14px; background: #101828; color: #ecfdf3; font: 12px/1.45 Consolas, "Cascadia Mono", monospace; white-space: pre-wrap; word-break: break-word; }
    pre.detail { margin: 0; max-height: 250px; overflow: auto; padding: 12px; border-radius: 6px; background: #101828; color: #ecfdf3; white-space: pre-wrap; word-break: break-word; font: 12px/1.45 Consolas, monospace; }
    .message { min-height: 20px; color: var(--muted); font-size: 12px; }
    .shutdown-status { display: grid; gap: 5px; padding: 10px; border: 1px solid #fedf89; border-radius: 6px; color: var(--warn); background: #fffaeb; font-size: 12px; }
    .worker { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding: 10px 0; }
    .worker:first-child { border-top: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px; text-align: left; overflow-wrap: anywhere; }
    th { color: var(--muted); font-weight: 600; }
    [hidden] { display: none !important; }
    @media (max-width: 920px) { header { align-items: flex-start; flex-direction: column; } .dashboard, .key-layout { grid-template-columns: 1fr; } #logs { height: 420px; } }
  </style>
</head>
<body>
  <header>
    <div><h1>${t.title}</h1><div class="meta">${t.localOnly}: http://127.0.0.1:2999 · ${formatServerConsoleMessage(t.ownership, { flavor })}</div></div>
    <nav aria-label="${t.management}">
      <a class="button ${isMain ? "active" : ""}" data-panel="servers" href="/">${t.server}</a>
      <a class="button ${isKeys ? "active" : ""}" data-panel="api-keys" href="/api-key-management">${t.apiKeyManagement}</a>
      <a class="button ${isBackups ? "active" : ""}" data-panel="backups" href="/database-management">${t.backupManagement}</a>
      <button id="refresh">${locale === "en" ? "Refresh" : "새로고침"}</button>
    </nav>
  </header>
  <main id="panel-servers" class="dashboard" ${isMain ? "" : "hidden"}>
    <div class="stack">
      <section>
        <div class="section-title">${locale === "en" ? "Service status" : "서비스 상태"} <span id="updated" class="meta"></span></div>
        <div class="content stack">
          <div class="service">
            <div class="service-head"><div><div class="name">${t.quickHackApp}</div><div class="meta" id="quickhack-url">https://127.0.0.1:${PORTS.gateway}</div></div><span id="quickhack-state" class="pill off">${t.checking}</span></div>
            <div class="buttons">
              <button id="quickhack-start" class="primary" data-action="/api/quickhack/start">${t.startAll}</button>
              <button id="quickhack-stop" class="danger" data-action="/api/quickhack/stop">${t.stopAll}</button>
              <a class="button" href="https://127.0.0.1:${PORTS.gateway}" target="_blank" rel="noreferrer">${t.open}</a>
              <button id="runtime-environment-toggle" class="toggle-button" data-action="/api/runtime/toggle-environment">${t.environment}</button>
              <button id="shutdown-force" class="danger" data-action="/api/shutdown/force" hidden disabled>${t.forceStop}</button>
            </div>
            <div id="quickhack-shutdown-status" class="shutdown-status" hidden><strong>${t.shutdown}</strong><span id="shutdown-state"></span></div>
            <div class="meta">${t.runtimeHelp}</div>
          </div>
          <div class="service"><div class="service-head"><div class="name">${t.postgresql}</div><span id="database-state" class="pill off">${t.checking}</span></div></div>
          ${serviceCards}
          <div class="service">
            <div class="service-head"><div class="name">${t.tls}</div><span id="tls-state" class="pill off">${t.checking}</span></div>
            <div class="buttons"><button class="primary" data-action="/api/tls/initialize">${t.renew}</button><a class="button" href="/api-key-management">${t.quickHackKeyManagement}</a></div>
            <div class="meta" id="tls-detail"></div>
          </div>
          <div class="service">
            <div class="service-head"><div class="name">${t.runtime}</div></div>
            <div class="buttons"><button id="coupang-write-api-toggle" class="toggle-button" data-action="/api/runtime/toggle-coupang-write-api">${t.coupangWrite}</button><button id="logen-write-api-toggle" class="toggle-button" data-action="/api/runtime/toggle-logen-write-api">${t.logenWrite}</button></div>
          </div>
          <div class="service"><div class="service-head"><div class="name">${t.otp}</div></div><div class="meta" id="otp-summary">${t.serverState}</div><a class="button" href="/api-key-management">${t.quickHackKeyManagement}</a></div>
          <p id="message" class="message" role="status"></p>
        </div>
      </section>
      <section>
        <div class="section-title">${locale === "en" ? "Server clock" : "서버 시계"}</div>
        <div class="content"><dl><dt>KST</dt><dd id="clock-kst">-</dd><dt>UTC</dt><dd id="clock-utc">-</dd><dt>${locale === "en" ? "OS time zone" : "OS 시간대"}</dt><dd id="clock-tz">-</dd></dl></div>
      </section>
      <section>
        <div class="section-title">${locale === "en" ? "Paths" : "경로"}</div>
        <div class="content"><dl><dt>${t.workspace}</dt><dd id="path-root">-</dd><dt>${t.node}</dt><dd id="path-node">-</dd><dt>${t.runtimeConfig}</dt><dd id="path-runtime-config">-</dd><dt>${t.data}</dt><dd id="path-data">-</dd><dt>${t.quickHackDb}</dt><dd id="path-db">-</dd><dt>${t.clientTlsConfig}</dt><dd id="path-tls-client">-</dd></dl></div>
      </section>
    </div>
    <section>
      <div class="section-title">${t.serverLogs}</div>
      <div class="tabs">${logTabs}</div>
      <pre id="logs" aria-live="polite">${t.checking}</pre>
    </section>
  </main>
  <main id="panel-api-keys" class="detail-layout key-layout" ${isKeys ? "" : "hidden"}>
    <section><div class="section-title">${locale === "en" ? "Current status" : "현재 상태"}<span id="key-state" class="pill off">${t.checking}</span></div><div class="content stack"><dl><dt>USB</dt><dd id="status-drive">-</dd><dt>${locale === "en" ? "Coupang key" : "Coupang 키"}</dt><dd id="status-file">-</dd><dt>${locale === "en" ? "Environment" : "환경"}</dt><dd id="status-environment">-</dd><dt>${locale === "en" ? "Alias" : "별칭"}</dt><dd id="status-alias">-</dd><dt>${locale === "en" ? "Fingerprint" : "지문"}</dt><dd id="status-fingerprint">-</dd><dt>${locale === "en" ? "Issued" : "발급 시각"}</dt><dd id="status-issued">-</dd><dt>${locale === "en" ? "Expires" : "만료 시각"}</dt><dd id="status-expires">-</dd><dt>${locale === "en" ? "Master key" : "마스터 키"}</dt><dd id="status-master">-</dd><dt>${t.logen}</dt><dd id="status-logen">-</dd></dl><p id="status-message" class="message"></p></div></section>
    <section><div class="section-title">${t.apiKeyManagement}<a class="button" data-panel="quickhack-keys" href="#panel-quickhack-keys">${t.quickHackKeyManagement}</a></div><div class="content stack"><p class="muted">${flavor === "OPERATIONAL" ? t.operationalHelp : t.demonstrationHelp}</p>${integrationHtml}<div class="service"><h2>${t.replacement}</h2><pre id="qhkey-replacement-state" class="detail">${t.replacementNone}</pre><p id="qhkey-authorization" hidden>${t.replacementAuthorize} <code id="qhkey-authorization-command"></code></p><div class="buttons"><button id="qhkey-replacement-refresh">${t.replacementRefresh}</button><button id="qhkey-replacement-cancel" class="danger" disabled>${t.replacementCancel}</button></div></div></div></section>
    <section id="panel-quickhack-keys"><div class="section-title">${t.quickHackKeyManagement}</div><div class="content stack"><div class="service"><h2>${t.qhkey}</h2><pre id="qhkey-state" class="detail">${t.checking}</pre><form id="master-key-import-form" hidden><input name="root" placeholder="${t.qhkeyVolume}"><input name="sourceFile" placeholder="${t.masterKeySource}"><button type="submit">${t.masterKeyImport}</button></form></div><div class="service"><h2>${t.tls}</h2><div class="buttons"><button data-action="/api/tls/rotate">${t.rotate}</button><button data-action="/api/tls/finalize-rotation">${t.finalize}</button></div><p class="muted">${t.rotationHelp}</p></div><div class="service"><h2>${t.otp}</h2><p class="muted">${t.otpHelp}</p><form id="otp-security-form"><input id="otp-security-confirm" name="confirmText" autocomplete="off" placeholder="${t.confirmation}"><button id="otp-security-recover" type="submit">${t.resetOtp}</button></form><pre id="otp-security-state" class="detail">${t.serverState}</pre></div></div></section>
    <p id="key-message" class="message" role="status"></p>
  </main>
  <main id="panel-backups" class="detail-layout" ${isBackups ? "" : "hidden"}>
    <section><div class="section-title">${locale === "en" ? "PostgreSQL backup and recovery" : "PostgreSQL 백업·복구"}</div><div class="content stack"><div class="buttons"><button class="primary" data-action="/api/operator/backup">${t.runNow}</button><button id="retention-run">${t.runRetention}</button></div><p class="muted">${t.operatorHelp}</p><pre id="backup-state" class="detail">${t.checking}</pre></div></section>
    <section><div class="section-title">${locale === "en" ? "Automatic runs" : "자동 실행"}</div><div id="backup-workers" class="content"></div></section>
    <section><div class="section-title">${locale === "en" ? "Recovery points" : "복구 지점"}</div><div class="content"><table><thead><tr><th>${locale === "en" ? "Created" : "생성"}</th><th>${locale === "en" ? "Backup file" : "백업 파일"}</th><th>${locale === "en" ? "Status" : "상태"}</th></tr></thead><tbody id="backup-list"></tbody></table></div></section>
    <p id="backup-message" class="message" role="status"></p>
  </main>
  <script>
    const token = ${JSON.stringify(actionToken)};
    const flavor = ${JSON.stringify(flavor)};
    const noLogs = ${JSON.stringify(t.noLogs)};
    const actionMessages = ${JSON.stringify(actionMessages)};
    const headers = { "X-QuickHack-Console-Token": token };
    const logEntries = [];
    let logSequence = 0;
    let activeLog = "application";
    let replacementId = "";
    const replacementStorageKey = "quickhack-qhkey-replacement-" + flavor;
    const $ = (id) => document.getElementById(id);
    try { replacementId = localStorage.getItem(replacementStorageKey) || ""; } catch {}
    const qhkeyAuthorizeCommand = "/usr/bin/quickhack-" + flavor.toLowerCase() + "-server-qhkey-authorize ";

    function message(value) {
      for (const id of ["message", "key-message", "backup-message"]) $(id).textContent = value;
    }
    function pill(node, running, healthy, onText, offText) {
      node.className = "pill " + (running ? (healthy ? "ok" : "warn") : "off");
      node.textContent = running ? onText : offText;
    }
    function renderLogs() {
      const visible = logEntries.filter((entry) => {
        if (!activeLog) return true;
        if (activeLog === "application") return ["backend", "gateway", "quickhack"].includes(entry.server);
        if (activeLog === "supervisor") return ["supervisor", "console"].includes(entry.server);
        return entry.server === activeLog;
      });
      const node = $("logs");
      node.textContent = visible.length
        ? visible.map((entry) => entry.at + " [" + entry.server + "] " + entry.line).join("\\n")
        : noLogs;
      node.scrollTop = node.scrollHeight;
    }
    async function refreshLogs() {
      try {
        const response = await fetch("/api/logs?after=" + logSequence, { headers, cache: "no-store" });
        if (!response.ok) throw Error("LOGS_UNAVAILABLE");
        const payload = await response.json();
        for (const entry of payload.entries || []) {
          logEntries.push(entry);
          logSequence = Math.max(logSequence, entry.sequence);
        }
        if (logEntries.length > 500) logEntries.splice(0, logEntries.length - 500);
        renderLogs();
      } catch { $("logs").textContent = "LOGS_UNAVAILABLE"; }
    }
    function renderWorkers(state) {
      const target = $("backup-workers");
      target.replaceChildren();
      for (const worker of state?.workers || []) {
        const row = document.createElement("div");
        row.className = "worker";
        const name = document.createElement("strong");
        name.textContent = worker.worker_key || worker.workerKey || "";
        const button = document.createElement("button");
        button.textContent = (worker.schedule_enabled ?? worker.scheduleEnabled)
          ? ${JSON.stringify(t.disableSchedule)} : ${JSON.stringify(t.enableSchedule)};
        button.onclick = () => post("/api/database-management/schedule", {
          workerKey: name.textContent,
          scheduleEnabled: !(worker.schedule_enabled ?? worker.scheduleEnabled),
        });
        row.append(name, button);
        target.append(row);
      }
    }
    function renderBackups(state) {
      const target = $("backup-list");
      target.replaceChildren();
      for (const backup of state?.backups || []) {
        const row = document.createElement("tr");
        const date = document.createElement("td");
        const file = document.createElement("td");
        const validity = document.createElement("td");
        date.textContent = backup.createdAt || backup.created_at || "-";
        file.textContent = backup.fileName || backup.file_name || "-";
        validity.textContent = backup.valid === false
          ? ${JSON.stringify(locale === "en" ? "Possibly damaged" : "손상 의심")}
          : backup.valid === true
            ? ${JSON.stringify(locale === "en" ? "Valid" : "검증 가능")}
            : ${JSON.stringify(locale === "en" ? "Unchecked" : "확인 필요")};
        row.append(date, file, validity);
        target.append(row);
      }
      if (!target.childElementCount) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.textContent = ${JSON.stringify(locale === "en" ? "No backups." : "백업이 없습니다.")};
        row.append(cell);
        target.append(row);
      }
    }
    async function refreshReplacement() {
      const stateElement = $("qhkey-replacement-state");
      const cancelButton = $("qhkey-replacement-cancel");
      const authorization = $("qhkey-authorization");
      authorization.hidden = true;
      cancelButton.disabled = true;
      if (!replacementId) {
        stateElement.textContent = ${JSON.stringify(t.replacementNone)};
        return;
      }
      try {
        const response = await fetch("/api/qhkey/replacement-status?transactionId=" + encodeURIComponent(replacementId), { headers, cache: "no-store" });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw Error(result.code || "QHKEY_STATUS_UNAVAILABLE");
        stateElement.textContent = JSON.stringify({
          transactionId: result.transactionId, provider: result.provider, state: result.state,
          keyAlias: result.keyAlias, keyFingerprint: result.keyFingerprint,
          expiresAt: result.expiresAt, errorCode: result.errorCode, message: result.message,
        }, null, 2);
        cancelButton.disabled = !["PREPARED", "AUTHORIZATION_REQUIRED"].includes(result.state);
        if (${JSON.stringify(process.platform)} === "linux" && result.state === "AUTHORIZATION_REQUIRED") {
          $("qhkey-authorization-command").textContent = qhkeyAuthorizeCommand + replacementId;
          authorization.hidden = false;
        }
      } catch (error) {
        stateElement.textContent = error?.message || "QHKEY_STATUS_UNAVAILABLE";
      }
    }
    async function refresh() {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        if (!response.ok) throw Error("STATUS_UNAVAILABLE");
        const state = await response.json();
        const active = state.applicationState === "ACTIVE";
        pill($("quickhack-state"), state.applicationState !== "INACTIVE", active, state.applicationState, ${JSON.stringify(t.stopped)});
        pill($("database-state"), state.database?.state === "ACTIVE", state.database?.state === "ACTIVE", state.database?.state || "-", state.database?.state || "-");
        pill($("tls-state"), state.tls?.ready === true, state.tls?.ready === true, ${JSON.stringify(t.running)}, ${JSON.stringify(t.stopped)});
        $("tls-detail").textContent = state.tls?.errors?.join(", ") || state.tls?.origin || "";
        $("updated").textContent = new Date(state.consoleDetails?.observedAt || Date.now()).toLocaleTimeString(${JSON.stringify(locale)});
        for (const row of document.querySelectorAll("[data-server]")) {
          const id = row.dataset.server;
          const process = state.processes?.[id] || {};
          const health = id === "backend" ? state.backend : id === "gateway" ? state.gateway : {};
          pill(row.querySelector(".server-state"), process.running, health.ok === true || process.running, ${JSON.stringify(t.running)}, ${JSON.stringify(t.stopped)});
          row.querySelector(".server-detail").textContent = process.pid ? "PID " + process.pid : ${JSON.stringify(t.stopped)};
        }
        const shutdown = state.shutdown;
        $("quickhack-shutdown-status").hidden = !shutdown || !!shutdown.completedAt;
        $("shutdown-state").textContent = shutdown
          ? [shutdown.phase, shutdown.durationMs ? Math.floor(shutdown.durationMs / 1000) + "s" : "", shutdown.errorMessage || ""].filter(Boolean).join(" / ")
          : "";
        $("shutdown-force").hidden = !shutdown || !!shutdown.completedAt;
        $("shutdown-force").disabled = !shutdown?.forceAvailable;
        const environment = state.runtimeSettings?.environment === "production";
        const environmentToggle = $("runtime-environment-toggle");
        environmentToggle.textContent = environment
          ? ${JSON.stringify(locale === "en" ? "Production mode" : "운영 모드")}
          : ${JSON.stringify(locale === "en" ? "Development mode" : "개발 모드")};
        environmentToggle.className = "toggle-button " + (environment ? "production" : "on");
        for (const [id, enabled, provider] of [
          ["coupang-write-api-toggle", state.runtimeSettings?.coupangWriteApiEnabled, "Coupang"],
          ["logen-write-api-toggle", state.runtimeSettings?.logenWriteApiEnabled, "Logen"],
        ]) {
          const button = $(id);
          button.textContent = provider + (enabled
            ? ${JSON.stringify(locale === "en" ? " writes enabled" : " 쓰기 허용")}
            : ${JSON.stringify(locale === "en" ? " writes blocked" : " 쓰기 차단")});
          button.className = "toggle-button " + (enabled ? "on" : "blocked");
        }
        $("otp-summary").textContent = state.totpSecurity?.message || state.totpSecurity?.key?.state || ${JSON.stringify(t.serverState)};
        $("otp-security-state").textContent = JSON.stringify(state.totpSecurity || {}, null, 2);
        $("qhkey-state").textContent = JSON.stringify(state.qhkey || {}, null, 2);
        const key = state.qhkey || {};
        const coupang = key.coupang || {};
        const metadata = coupang.metadata || {};
        pill($("key-state"), coupang.readable === true, coupang.readable === true, ${JSON.stringify(t.running)}, ${JSON.stringify(t.stopped)});
        $("status-drive").textContent = key.selectedRoot || "-";
        $("status-file").textContent = coupang.qhkeyFile || "-";
        $("status-environment").textContent = metadata.environment || "-";
        $("status-alias").textContent = metadata.keyAlias || "-";
        $("status-fingerprint").textContent = metadata.keyFingerprint || "-";
        $("status-issued").textContent = metadata.issuedAt || "-";
        $("status-expires").textContent = metadata.expiresAt || "-";
        $("status-master").textContent = key.masterKeyExists ? key.masterKeyProtection || "OK" : "-";
        $("status-logen").textContent = key.logen?.qhkeyFile || "-";
        $("status-message").textContent = key.errorMessage || coupang.errorMessage || "";
        const backups = state.backups?.state || state.backups || {};
        $("backup-state").textContent = JSON.stringify(backups, null, 2);
        renderWorkers(backups);
        renderBackups(backups);
        $("master-key-import-form").hidden = state.qhkey?.platform !== "win32" || flavor !== "OPERATIONAL";
        const details = state.consoleDetails || {};
        const observed = details.observedAt ? new Date(details.observedAt) : null;
        $("clock-kst").textContent = observed ? observed.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-";
        $("clock-utc").textContent = details.observedAt || "-";
        $("clock-tz").textContent = details.timeZone || "-";
        $("path-root").textContent = details.root || "-";
        $("path-node").textContent = details.nodeExecutable || "-";
        $("path-runtime-config").textContent = details.runtimeConfigPath || "-";
        $("path-data").textContent = details.dataDirectory || "-";
        $("path-db").textContent = details.database || "-";
        $("path-tls-client").textContent = details.tlsClientConfigDirectory || "-";
        await refreshReplacement();
      } catch (error) {
        message(error?.message || "STATUS_UNAVAILABLE");
      }
    }
    async function post(url, body) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw Error(payload.message || payload.code || "REQUEST_FAILED");
        if (payload.transactionId) {
          replacementId = payload.transactionId;
          try { localStorage.setItem(replacementStorageKey, replacementId); } catch {}
        }
        message(actionMessages[payload.messageCode] || payload.message || payload.code || ${JSON.stringify(locale === "en" ? "Done" : "완료")});
        await refresh();
        await refreshLogs();
        return payload;
      } catch (error) {
        message(error?.message || "REQUEST_FAILED");
        return { ok: false };
      }
    }
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try { await post(button.dataset.action); } finally { button.disabled = false; }
      };
    });
    document.querySelectorAll("[data-server-action]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try { await post("/api/servers/" + button.dataset.serverId + "/" + button.dataset.serverAction); }
        finally { button.disabled = false; }
      };
    });
    document.querySelectorAll("[data-log]").forEach((button) => {
      button.onclick = () => {
        activeLog = button.dataset.log;
        document.querySelectorAll("[data-log]").forEach((item) => item.classList.toggle("active", item === button));
        renderLogs();
      };
    });
    $("refresh").onclick = async () => { await refresh(); await refreshLogs(); };
    $("qhkey-replacement-refresh").onclick = refreshReplacement;
    $("qhkey-replacement-cancel").onclick = () => {
      if (replacementId) void post("/api/qhkey/replacement-cancel", { transactionId: replacementId });
    };
    $("retention-run").onclick = () => post("/api/database-management/run", { workerKey: "backup-retention-and-integrity" });
    $("otp-security-form").onsubmit = async (event) => {
      event.preventDefault();
      await post("/api/totp-security/recover", { confirmText: new FormData(event.currentTarget).get("confirmText") });
    };
    $("master-key-import-form").onsubmit = async (event) => {
      event.preventDefault();
      await post("/api/qhkey/import-master", Object.fromEntries(new FormData(event.currentTarget)));
    };
    window.quickHackConsolePost = post;
    setInterval(() => { void refresh(); void refreshLogs(); }, 2000);
    void refresh();
    void refreshLogs();
  </script>
</body>
</html>`;
}
