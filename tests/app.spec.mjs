// End-to-end tests for the app. Provider APIs are mocked with route interception; nothing reaches the network.
import { test, expect } from "@playwright/test";
import fs from "node:fs";

const ANTHROPIC = "https://api.anthropic.com/";
const OPENAI = "https://api.openai.com/";
const KEY_A = "sk-ant-test-0000000000001234";
const KEY_O = "sk-test-openai-000000005678";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

// Routes one provider. `models` answers the verify call; `messages` is a list of replies for chat calls, used in order.
async function mockProvider(page, base, { models = { status: 200, body: { data: [] } }, messages = [] } = {}) {
  const log = { verify: [], chat: [] };
  await page.route(base + "**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = req.url();
    if (/\/v1\/models/.test(url)) {
      log.verify.push({ headers: req.headers() });
      if (models === "abort") return route.abort("internetdisconnected");
      return route.fulfill({ status: models.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(models.body) });
    }
    log.chat.push({ headers: req.headers(), body: req.postDataJSON() });
    const reply = messages[Math.min(log.chat.length - 1, messages.length - 1)];
    const body = typeof reply.body === "function" ? await reply.body(log) : reply.body;
    return route.fulfill({ status: reply.status || 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  });
  return log;
}

async function onboard(page, provider, key) {
  await page.getByRole("radio", { name: provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI" }).click();
  await page.getByLabel("3. Paste your key").fill(key);
  await page.getByRole("button", { name: "Verify" }).click();
}
const nav = (page, name) => page.locator("nav").getByRole("button", { name, exact: true }).click();
const desk = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("second-name-desk-v2") || "null"));

test.beforeEach(async ({ page }) => {
  // Capture clipboard writes so the export can be inspected.
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
  });
  // The desktop app's web view ignores native dialogs, so the app must never rely on one.
  page.__nativeDialogs = [];
  page.on("dialog", (d) => { page.__nativeDialogs.push(d.message()); d.dismiss(); });
});
test.afterEach(async ({ page }) => { expect(page.__nativeDialogs, "native confirm/alert dialogs").toEqual([]); });

test("onboarding is the first screen and blocks the app until a key is verified", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect your AI key" })).toBeVisible();
  await expect(page.locator("nav")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Desk" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Anthropic (Claude)" }).click();
  await expect(page.locator("#keylink")).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  await expect(page.locator("#keynote")).toContainText("stored only on this device");
  await page.getByRole("radio", { name: "OpenAI" }).click();
  await expect(page.locator("#keylink")).toHaveAttribute("href", "https://platform.openai.com/account/api-keys");
  // Reloading without a key still lands on onboarding.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect your AI key" })).toBeVisible();
});

test("verify success with Anthropic sends the browser-access header and opens the app", async ({ page }) => {
  const log = await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
  await expect(page.locator("nav")).toBeVisible();
  expect(log.verify).toHaveLength(1);
  expect(log.verify[0].headers["x-api-key"]).toBe(KEY_A);
  expect(log.verify[0].headers["anthropic-version"]).toBe("2023-06-01");
  expect(log.verify[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  await nav(page, "You");
  await expect(page.locator("#aikeylabel")).toHaveText("AI key: Anthropic, ••••1234");
});

test("verify success with OpenAI uses a bearer token", async ({ page }) => {
  const log = await mockProvider(page, OPENAI);
  await page.goto("/");
  await onboard(page, "openai", KEY_O);
  await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
  expect(log.verify[0].headers["authorization"]).toBe("Bearer " + KEY_O);
  await nav(page, "You");
  await expect(page.locator("#aikeylabel")).toHaveText("AI key: OpenAI, ••••5678");
});

const failures = [
  ["anthropic", "invalid key (401)", { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }, "invalid_key", /didn't accept that key/],
  ["openai", "invalid key (401)", { status: 401, body: { error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided" } } }, "invalid_key", /didn't accept that key/],
  ["anthropic", "no credit (400 credit balance)", { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } }, "no_credit", /no credit left/],
  ["anthropic", "billing error (402)", { status: 402, body: { type: "error", error: { type: "billing_error", message: "billing" } } }, "no_credit", /no credit left/],
  ["openai", "no credit (429 credit_balance_exhausted)", { status: 429, body: { error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "no credits" } } }, "no_credit", /no credit left/],
  ["anthropic", "key not scoped to a workspace (400)", { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use." } } }, "needs_workspace", /inside one workspace/],
  ["anthropic", "rate limited (429)", { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } }, "rate_limited", /rate or spending limit/],
  ["openai", "network error", "abort", "network", /Couldn't reach OpenAI/],
];
for (const [prov, name, models, code, text] of failures) {
  test(`verify failure: ${prov} ${name}`, async ({ page }) => {
    await mockProvider(page, prov === "anthropic" ? ANTHROPIC : OPENAI, { models });
    await page.goto("/");
    await onboard(page, prov, prov === "anthropic" ? KEY_A : KEY_O);
    const r = page.locator("#obresult");
    await expect(r).toHaveAttribute("data-code", code);
    await expect(r).toContainText(text);
    await expect(page.locator("nav")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("second-name-ai-key"))).toBeNull();
  });
}

test("the key never appears in the Copy everything export or the desk data", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "You");
  await page.getByRole("button", { name: "Copy everything as text" }).click();
  await expect(page.locator("#toast")).toContainText("Copied");
  const copied = await page.evaluate(() => window.__copied.join("\n"));
  expect(copied.length).toBeGreaterThan(100);
  expect(JSON.parse(copied).venues.length).toBeGreaterThan(0);
  expect(copied).not.toContain(KEY_A);
  expect(copied).not.toContain("1234");
  expect(JSON.stringify(await desk(page))).not.toContain(KEY_A);
});

test("removing the key returns to onboarding", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "You");
  await page.locator("#aikey").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Remove the AI key from this device?");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByRole("heading", { name: "Connect your AI key" })).toBeVisible();
  await expect(page.locator("nav")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("second-name-ai-key"))).toBeNull();
});

test("copilot tool loop adds a poem on Anthropic", async ({ page }) => {
  const log = await mockProvider(page, ANTHROPIC, { messages: [
    { body: { content: [{ type: "text", text: "Saving it." }, { type: "tool_use", id: "toolu_1", name: "addPoem", input: { title: "Harbor Test", text: "a test line\nanother", tags: "test" } }], stop_reason: "tool_use" } },
    { body: { content: [{ type: "text", text: "Saved Harbor Test." }], stop_reason: "end_turn" } },
  ] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Copilot");
  await page.locator("#chatbox").fill("Please save my poem Harbor Test: a test line / another");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Saved Harbor Test.");
  expect(log.chat).toHaveLength(2);
  const [first, second] = log.chat.map((c) => c.body);
  expect(first.model).toBe("claude-haiku-4-5-20251001");
  expect(first.system).toContain("You critique; you do not write");
  expect(first.tools.map((t) => t.name)).toEqual(["addPoem", "updatePoem", "updateProfile", "setPacketPoems"]);
  expect(first.messages[0]).toEqual({ role: "user", content: "Please save my poem Harbor Test: a test line / another" });
  expect(log.chat[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(second.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
  expect((await desk(page)).poems.map((p) => p.title)).toEqual(["Harbor Test"]);
  await nav(page, "Poems");
  await expect(page.getByRole("heading", { name: "Harbor Test" })).toBeVisible();
});

test("copilot tool loop adds a poem on OpenAI", async ({ page }) => {
  const log = await mockProvider(page, OPENAI, { messages: [
    { body: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "addPoem", arguments: JSON.stringify({ title: "Ferry Test", text: "one line" }) } }] } }] } },
    { body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Saved Ferry Test." } }] } },
  ] });
  await page.goto("/");
  await onboard(page, "openai", KEY_O);
  await nav(page, "Copilot");
  await page.locator("#chatbox").fill("Save my poem Ferry Test: one line");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Saved Ferry Test.");
  expect(log.chat).toHaveLength(2);
  const [first, second] = log.chat.map((c) => c.body);
  expect(first.model).toBe("gpt-6-luna");
  expect(first.reasoning_effort).toBe("none");
  expect(first.messages[0].role).toBe("system");
  expect(first.tools[0]).toMatchObject({ type: "function", function: { name: "addPoem" } });
  expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  expect(second.messages.at(-2).tool_calls[0].id).toBe("call_1");
  expect((await desk(page)).poems.map((p) => p.title)).toEqual(["Ferry Test"]);
});

test("copilot tool loop stops after 4 model calls", async ({ page }) => {
  const log = await mockProvider(page, ANTHROPIC, { messages: [
    { body: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t", name: "updatePoem", input: { id: "nope" } }], stop_reason: "tool_use" } },
  ] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Copilot");
  await page.locator("#chatbox").fill("loop forever");
  await page.getByRole("button", { name: "Send" }).click();
  // Wait for the loop to finish (Send returns and the reply is saved), not just the first streamed text.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.locator(".msg.assistant:not(#live)").last()).toContainText("Looking.");
  expect(log.chat).toHaveLength(4);
  expect((await desk(page)).chat.at(-1).role).toBe("assistant");
});

test("copilot errors use the same plain messages as onboarding", async ({ page }) => {
  await mockProvider(page, ANTHROPIC, { messages: [{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "bad" } } }] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Copilot");
  await page.locator("#chatbox").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#toast")).toContainText("didn't accept that key");
});

test("venue import merges venues without touching poems", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Poems");
  await page.getByRole("button", { name: "Add a poem" }).click();
  await page.getByLabel("Title").fill("Import Guard");
  await page.getByLabel("Text").fill("first line\nsecond line");
  await page.getByLabel("Title").press("Tab");
  await page.getByLabel("Text").blur();
  const before = await desk(page);
  expect(before.poems.map((p) => p.title)).toEqual(["Import Guard"]);
  const n = before.venues.length;
  await nav(page, "You");
  const file = { venuefold: 1, exportedOn: "2026-10-01", venues: [
    { id: "vf-new", name: "Brand New Review", url: "https://new.example.org", fee: 0, maxPoems: 3, source: "venuefold" },
    { id: "vf-rattle", name: "Rattle", url: "https://rattle.example.org/updated", fee: 0, maxPoems: 4, notes: "updated by test" },
  ] };
  await page.locator('input[type="file"]').setInputFiles({ name: "desk-venues.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#toast")).toContainText("1 added, 1 updated");
  const after = await desk(page);
  expect(after.poems).toEqual(before.poems);
  expect(after.venues).toHaveLength(n + 1);
  expect(after.venues.find((v) => v.name === "Rattle").notes).toBe("updated by test");
});

test("a waiver limited to certain writers is not shown as a free window", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "You");
  const file = { venuefold: 1, exportedOn: "2026-10-04T20:00:00Z", venues: [
    { id: "vf-student", name: "Student Route Review", url: "https://s.example.edu", fee: 3, start: "11-13", end: "02-28", maxPoems: 5,
      waiver: { kind: "identity", email: "journal@s.example.edu", note: "Students of the college. Students may submit free by email" } },
  ] };
  await page.locator('input[type="file"]').setInputFiles({ name: "desk-venues.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#toast")).toContainText("1 added");
  await nav(page, "Dates");
  await page.getByRole("tab", { name: "List" }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Student Route Review" }) });
  await expect(card.locator(".chips").first()).toHaveText("Waiver for some writers");
  await expect(card).not.toContainText("Free windows");
});

test("a venue with no stated fee never shows as free", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Dates");
  await page.getByRole("tab", { name: "List" }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Bagazine", exact: true }) });
  await expect(card).toContainText("Fee not stated · Sep 2 to Sep 2");
  await expect(card).not.toContainText("Free");
  // Built-in venues that VenueFold can't read are listed too.
  await expect(page.locator(".card").filter({ has: page.getByRole("heading", { name: "Construction Magazine", exact: true }) })).toContainText("$3.00 · rolling");
  await expect(page.locator(".card").filter({ has: page.getByRole("heading", { name: "Call Me [Brackets]", exact: true }) })).toContainText("Jan 15 to Apr 1");
  // Imported venues with no fee stay "not stated" too.
  await nav(page, "You");
  const file = { venuefold: 1, exportedOn: "2026-10-04T21:00:00Z", venues: [{ id: "vf-nofee", name: "No Fee Stated Review", url: "https://n.example.org", fee: null, maxPoems: 3 }] };
  await page.locator('input[type="file"]').setInputFiles({ name: "desk-venues.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#toast")).toContainText("1 added");
  expect((await desk(page)).venues.find((v) => v.id === "vf-nofee").fee).toBeNull();
  await nav(page, "Dates");
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.locator(".card").filter({ has: page.getByRole("heading", { name: "No Fee Stated Review" }) })).toContainText("Fee not stated · rolling");
});

// Autopilot picks cheapest first: free, then fee-waivable, then paid. A venue with no stated fee must rank
// with paid venues. Built-in venues are taken out of the running (marked sent) so only the test venues compete,
// and the queue has room for one packet. The no-fee venue is listed first, so it would win if it ranked as free.
for (const [rival, label] of [
  [{ id: "t-free", name: "Free Rival Review", fee: 0 }, "a free venue"],
  [{ id: "t-waiver", name: "Waiver Rival Review", fee: 3, waiver: { kind: "email", email: "ed@w.example.org", note: "Waived on request" } }, "a paid venue with an email waiver"],
]) {
  test(`autopilot ranks a venue with no stated fee after ${label}`, async ({ page }) => {
    await mockProvider(page, ANTHROPIC);
    await page.goto("/");
    await onboard(page, "anthropic", KEY_A);
    await nav(page, "You");
    const seeds = (await desk(page)).venues.map((v) => v.id);
    const open = { url: "https://example.org/submit", start: "", end: "", tags: "general", maxPoems: 3, checked: "2026-10-04", notes: "" };
    const testDesk = {
      tab: "desk", budget: 25, maxQueue: 1, lead: 60, name: "Test Poet", bio: "Writes poems.", pitch: "",
      poems: [{ id: "p-test", title: "Ranking Test", author: "", second: "", text: "one line\nanother line", tags: "general", revs: [], path: [] }],
      venues: [...(await desk(page)).venues, { id: "t-nofee", name: "No Fee Stated Review", fee: null, ...open }, { ...open, ...rival }],
      queue: seeds.map((id, i) => ({ id: "sent-" + i, vid: id, poemIds: [], note: "", status: "sent", waiver: "none", sentAt: "2026-01-01T00:00:00Z" })),
    };
    await page.evaluate((d) => localStorage.setItem("second-name-desk-v2", JSON.stringify(d)), testDesk);
    await page.reload();
    await page.getByRole("button", { name: "Prepare packets" }).click();
    await expect(page.locator("#toast")).toContainText("1 packet prepared");
    const after = await desk(page);
    const picked = after.queue.filter((q) => q.status !== "sent").map((q) => after.venues.find((v) => v.id === q.vid).name);
    expect(picked).toEqual([rival.name]);
  });
}

test("a venue marked not-in-autopilot is listed but never queued", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "You");
  const d = await desk(page);
  // Every built-in venue except Construction Magazine is taken out of the running.
  const others = d.venues.filter((v) => v.name !== "Construction Magazine").map((v) => v.id);
  Object.assign(d, { tab: "desk", name: "Test Poet", bio: "Writes poems.", maxQueue: 5,
    poems: [{ id: "p-test", title: "Pause Test", author: "", second: "", text: "one line", tags: "general", revs: [], path: [] }],
    queue: others.map((id, i) => ({ id: "sent-" + i, vid: id, poemIds: [], note: "", status: "sent", waiver: "none", sentAt: "2026-01-01T00:00:00Z" })) });
  await page.evaluate((x) => localStorage.setItem("second-name-desk-v2", JSON.stringify(x)), d);
  await page.reload();
  await page.getByRole("button", { name: "Prepare packets" }).click();
  await expect(page.locator("#toast")).toContainText("No new venues fit right now");
  expect((await desk(page)).queue.filter((q) => q.status !== "sent")).toHaveLength(0);
  await nav(page, "Dates");
  await page.getByRole("tab", { name: "List" }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Construction Magazine", exact: true }) });
  await expect(card).toContainText("Not in autopilot");
  await expect(card).toContainText("site has been unreachable");
});

test("starts with zero poems and no seeded poem data", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  expect((await desk(page) || { poems: [] }).poems).toEqual([]);
  await nav(page, "Poems");
  await expect(page.locator(".top .meta")).toContainText("0 poems");
  const src = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(src).toMatch(/poems:\[\],/);
  expect(src).not.toMatch(/path:\[\s*\{k:/);
});

test.describe("offline", () => {
  test.use({ serviceWorkers: "allow" });
  test("the app loads offline after the first visit", async ({ page, context }) => {
    await page.addInitScript((k) => localStorage.setItem("second-name-ai-key", JSON.stringify({ provider: "anthropic", key: k, verifiedAt: "2026-10-04T00:00:00Z" })), KEY_A);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
    await expect(page.locator("nav")).toBeVisible();
    await context.setOffline(false);
  });
});

test("in-app confirmation: Cancel and Escape keep the poem, Delete removes it", async ({ page }) => {
  await mockProvider(page, ANTHROPIC);
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await nav(page, "Poems");
  await page.getByRole("button", { name: "Add a poem" }).click();
  await page.getByLabel("Title").fill("Keep Or Delete");
  await page.getByLabel("Title").press("Tab");
  const del = page.getByRole("button", { name: "Delete poem" });
  await del.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete “Keep Or Delete”?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await del.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await desk(page)).poems).toHaveLength(1);
  await del.click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await desk(page)).poems.length).toBe(0);
});

// The desktop shell (Tauri) is simulated by giving the page a window.__TAURI__ bridge that records calls.
test.describe("inside the desktop app", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__opened = []; window.__clip = [];
      window.__TAURI__ = {
        opener: { openUrl: (u) => { window.__opened.push(u); return Promise.resolve(); } },
        clipboardManager: { writeText: (t) => { window.__clip.push(t); return Promise.resolve(); } },
      };
    });
  });

  test("links open in the system browser, copying uses the desktop clipboard, no service worker", async ({ page, context }) => {
    const popups = []; context.on("page", (p) => popups.push(p));
    await mockProvider(page, ANTHROPIC);
    await page.goto("/");
    await onboard(page, "anthropic", KEY_A);
    await nav(page, "Dates");
    await page.getByRole("tab", { name: "List" }).click();
    const rattle = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Rattle", exact: true }) });
    await rattle.getByRole("link", { name: "Guidelines" }).click();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(["https://rattle.submittable.com/submit"]);
    expect(popups).toHaveLength(0);
    expect(page.url()).toMatch(/localhost:4173\/$/);
    await nav(page, "You");
    await page.getByRole("button", { name: "Copy everything as text" }).click();
    await expect.poll(() => page.evaluate(() => window.__clip.length)).toBe(1);
    expect(await page.evaluate(() => window.__copied.length)).toBe(0);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))).toBe(0);
  });

  test("venues refresh from the live site", async ({ page }) => {
    let asked = null;
    await page.route("https://joshtseppich.github.io/second-name/venues/desk-venues.json", (route) => {
      asked = route.request().url();
      route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ venuefold: 1, exportedOn: "2026-10-07T00:00:00Z", venues: [{ id: "vf-live", name: "Live Site Review", url: "https://live.example.org", fee: 0, maxPoems: 3 }] }) });
    });
    await page.goto("/");
    await expect.poll(() => asked).toBe("https://joshtseppich.github.io/second-name/venues/desk-venues.json");
    await expect.poll(async () => ((await desk(page)) || { venues: [] }).venues.some((v) => v.name === "Live Site Review")).toBe(true);
  });
});

// Profile and poem edits by the copilot. The reply that made changes always lists them.
const toolTurn = (input) => ({ body: { content: [{ type: "tool_use", id: "toolu_p", name: "updateProfile", input }], stop_reason: "tool_use" } });
const doneTurn = { body: { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" } };
async function askCopilot(page, text) {
  await nav(page, "Copilot");
  await page.locator("#chatbox").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("copilot edits the profile fields and lists what it changed", async ({ page }) => {
  const log = await mockProvider(page, ANTHROPIC, { messages: [toolTurn({ name: "Ada Lane", bio: "Ada Lane lives by the sea.", pitch: "Poems about tides.", maxQueue: 3, lead: 90 }), doneTurn] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await askCopilot(page, "Set my name to Ada Lane, bio to: Ada Lane lives by the sea. Pitch: Poems about tides. Queue 3, lead 90 days.");
  await expect(page.locator(".msg.assistant").last()).toContainText("[Changed: your name on submissions, bio, one line about the work, most packets kept queued, lead time]");
  expect(log.chat[0].body.system).toContain("One line about the work: (not set)");
  expect(log.chat[1].body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_p" });
  const d = await desk(page);
  expect({ name: d.name, bio: d.bio, pitch: d.pitch, maxQueue: d.maxQueue, lead: d.lead }).toEqual({ name: "Ada Lane", bio: "Ada Lane lives by the sea.", pitch: "Poems about tides.", maxQueue: 3, lead: 90 });
  await nav(page, "You");
  await expect(page.getByLabel("Name on submissions")).toHaveValue("Ada Lane");
  await expect(page.getByLabel("Bio")).toHaveValue("Ada Lane lives by the sea.");
});

test("raising the fee budget waits for the person: Cancel keeps it and tells the copilot", async ({ page }) => {
  const log = await mockProvider(page, ANTHROPIC, { messages: [toolTurn({ budget: 100, bio: "should not apply" }), doneTurn] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await askCopilot(page, "raise my budget to 100");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("raise your fee budget from $25.00 to $100.00");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Done.");
  await expect(page.locator(".msg.assistant").last()).not.toContainText("[Changed");
  const d = await desk(page);
  expect([d.budget, d.bio]).toEqual([25, ""]);
  expect(log.chat[1].body.messages.at(-1).content[0]).toMatchObject({ is_error: true, content: expect.stringContaining("declined") });
});

test("raising the fee budget applies once the person allows it; lowering needs no prompt", async ({ page }) => {
  await mockProvider(page, ANTHROPIC, { messages: [toolTurn({ budget: 100 }), doneTurn, toolTurn({ budget: 10 }), doneTurn] });
  await page.goto("/");
  await onboard(page, "anthropic", KEY_A);
  await askCopilot(page, "raise my budget to 100");
  await page.getByRole("alertdialog").getByRole("button", { name: "Allow" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("[Changed: your fee budget]");
  expect((await desk(page)).budget).toBe(100);
  await page.locator("#chatbox").fill("lower it to 10");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant:not(#live)")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect((await desk(page)).budget).toBe(10);
});

test("copilot changes a poem's author on OpenAI", async ({ page }) => {
  const log = await mockProvider(page, OPENAI, { messages: [
    { body: async () => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "updatePoem", arguments: JSON.stringify({ id: (await desk(page)).poems[0].id, author: "Both of us" }) } }] } }] }) },
    { body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Author updated." } }] } },
  ] });
  await page.goto("/");
  await onboard(page, "openai", KEY_O);
  await nav(page, "Poems");
  await page.getByRole("button", { name: "Add a poem" }).click();
  await page.getByLabel("Title").fill("Shared Poem");
  await page.getByLabel("Title").press("Tab");
  await askCopilot(page, "Make the author of Shared Poem 'Both of us'");
  await expect(page.locator(".msg.assistant").last()).toContainText("[Changed: “Shared Poem”: author]");
  expect((await desk(page)).poems[0].author).toBe("Both of us");
  expect(log.chat[0].body.tools.map((t) => t.function.name)).toContain("updateProfile");
});
