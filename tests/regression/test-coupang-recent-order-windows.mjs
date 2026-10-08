import assert from "node:assert/strict";

const { recentOrdersheetWindows } = await import(
  "@/quickhack_server/sales-channel/coupang/recent-order-windows"
);

const now = new Date("2026-10-07T15:05:42.000Z");
const windows = recentOrdersheetWindows(now);
assert.equal(windows[0].from, "2026-10-07T23:35+09:00");
assert.equal(windows.at(-1).to, "2026-10-08T00:05+09:00");

for (const window of windows) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  assert.equal(window.from.slice(0, 10), window.to.slice(0, 10));
  assert.ok(to >= from && to - from <= 10 * 60_000);
}

for (let minute = Date.parse(windows[0].from); minute <= Date.parse(windows.at(-1).to); minute += 60_000) {
  assert.ok(windows.some((window) =>
    Date.parse(window.from) <= minute && minute <= Date.parse(window.to)
  ), `Uncovered minute: ${new Date(minute).toISOString()}`);
}

console.log("Recent Coupang order windows cover midnight without a gap.");
