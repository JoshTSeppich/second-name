// VenueFold tests: saved HTML fixtures only. No network and no API calls.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(HERE, "fixtures", n), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "venuefold-test-"));
process.env.VENUEFOLD_STORE = path.join(TMP, "venues.json");
process.env.VENUEFOLD_DELAY_MS = "0";
process.env.VENUEFOLD_RENDER = "0";        // never launch a real browser in tests; render tests inject a fake

let vf;
before(async () => { vf = await import("../venuefold.mjs"); });

// Every fetch is answered from fixtures; any other URL fails the test.
function fakeFetch(pages) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private\n", { status: 200 });
    if (u in pages) { const r = new Response(pages[u], { status: 200, headers: { "content-type": "text/html" } }); Object.defineProperty(r, "url", { value: u }); return r; }
    throw new Error("unexpected network call in test: " + u);
  };
  return calls;
}
const noApi = { messages: { create: async () => { throw new Error("API must not be called"); } } };

test("pageText extracts readable text and drops scripts, styles, nav and footer", () => {
  const p = vf.pageText(fixture("guidelines.html"), "https://lanternstreet.org/submit");
  assert.equal(p.title, "Submission Guidelines | Lantern Street Review");
  assert.match(p.text, /reads poetry submissions during two reading periods/);
  assert.match(p.text, /The general submission fee is \$3\./);
  assert.doesNotMatch(p.text, /should not appear|dynamic|Copyright footer|About/);
  assert.ok(p.links.some((l) => l.href === "https://lanternstreet.submittable.com/submit"));
  assert.ok(p.links.some((l) => l.href === "https://lanternstreet.org/about"), "relative links resolve against the page URL");
});

test("pageText finds plain and obfuscated emails and filters junk", () => {
  const { emails } = vf.pageText(fixture("guidelines.html"), "https://lanternstreet.org/submit");
  assert.ok(emails.includes("editors@lanternstreet.org"), "plain email, lowercased");
  assert.ok(emails.includes("waivers@lanternstreet.org"), "decoded from 'waivers [at] lanternstreet [dot] org'");
  assert.ok(!emails.includes("user@example.com"), "placeholder address filtered");
  assert.ok(!emails.some((e) => e.endsWith(".png")), "image filenames filtered");
});

test("crawl skips the API call when the page hash is unchanged", async () => {
  const url = "https://lanternstreet.org/submit", html = fixture("guidelines.html");
  const hash = (await import("node:crypto")).createHash("sha256").update(vf.pageText(html, url).text).digest("hex").slice(0, 16);
  vf.save({ venues: { "lantern-street-review": { name: "Lantern Street Review", url, pageHash: hash, checkedOn: "2020-01-01", record: { name: "Lantern Street Review" } } } });
  vf.setClient(noApi);
  const calls = fakeFetch({ [url]: html });
  await vf.crawl({ limit: 0 });
  const v = vf.load().venues["lantern-street-review"];
  assert.equal(v.checkedOn, new Date().toISOString().slice(0, 10), "check date moves forward");
  assert.equal(v.lastError, null);
  assert.equal(v.pageHash, hash);
  assert.deepEqual(calls.filter((c) => !c.endsWith("robots.txt")), [url]);
});

test("crawl calls the extractor once when the page changed, keeping history", async () => {
  const url = "https://lanternstreet.org/submit";
  vf.save({ venues: { "lantern-street-review": { name: "Lantern Street Review", url, pageHash: "old", checkedOn: "2020-01-01", record: { name: "Old record" } } } });
  let n = 0;
  vf.setClient({ messages: { create: async (req) => { n++; assert.equal(req.tool_choice.name, "record_venue"); return { content: [{ type: "tool_use", name: "record_venue", input: { name: "Lantern Street Review", acceptsPoetry: true, confidence: "high", windows: [], yearRound: true, notes: "", evidence: [] } }] }; } } });
  fakeFetch({ [url]: fixture("guidelines.html") });
  await vf.crawl({ limit: 0 });
  const v = vf.load().venues["lantern-street-review"];
  assert.equal(n, 1);
  assert.equal(v.record.name, "Lantern Street Review");
  assert.equal(v.history.at(-1).record.name, "Old record");
});

test("crawl reports JavaScript-only pages as errors without calling the API", async () => {
  const url = "https://spa.example.net/";
  vf.save({ venues: { spa: { name: "SPA Journal", url } } });
  vf.setClient(noApi);
  vf.setRenderer(null);
  fakeFetch({ [url]: fixture("js-shell.html") });
  await vf.crawl({ limit: 0 });
  assert.match(vf.load().venues.spa.lastError, /built by JavaScript/);
});

const okClient = (calls) => ({ messages: { create: async (req) => { calls.push(req); return { content: [{ type: "tool_use", name: "record_venue", input: { name: "Lantern Street Review", acceptsPoetry: true, confidence: "high", windows: [], yearRound: true, notes: "", evidence: [] } }] }; } } });

test("JavaScript-only pages are rendered in a browser and then extracted", async () => {
  const url = "https://spa.example.net/";
  vf.save({ venues: { spa: { name: "SPA Journal", url } } });
  const calls = [], rendered = [];
  vf.setClient(okClient(calls));
  vf.setRenderer(async (u) => { rendered.push(u); return { html: fixture("guidelines.html"), finalUrl: u }; });
  fakeFetch({ [url]: fixture("js-shell.html") });
  await vf.crawl({ limit: 0 });
  vf.setRenderer(null);
  const v = vf.load().venues.spa;
  assert.deepEqual(rendered, [url]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /reads poetry submissions during two reading periods/);
  assert.equal(v.lastError, null);
  assert.equal(v.guidelinesUrl, url);
});

test("a rendered home page leads to its rendered submissions page", async () => {
  const url = "https://blog.example.net/", submit = "https://blog.example.net/p/submit.html";
  const home = `<html><body><h1>Blog</h1><p>${"Recent posts about the magazine and its contributors. ".repeat(12)}</p><a href="/p/submit.html">Submit</a></body></html>`;
  vf.save({ venues: { blog: { name: "Blog Journal", url } } });
  const calls = [], rendered = [];
  vf.setClient(okClient(calls));
  vf.setRenderer(async (u) => { rendered.push(u); return { html: u === submit ? fixture("guidelines.html") : home, finalUrl: u }; });
  fakeFetch({ [url]: fixture("js-shell.html") });
  await vf.crawl({ limit: 0 });
  vf.setRenderer(null);
  assert.deepEqual(rendered, [url, submit]);
  assert.equal(calls.length, 1);
  assert.equal(vf.load().venues.blog.guidelinesUrl, submit);
});

test("a page that stays empty in the browser is reported, not extracted", async () => {
  const url = "https://spa.example.net/";
  vf.save({ venues: { spa: { name: "SPA Journal", url } } });
  vf.setClient(noApi);
  vf.setRenderer(async (u) => ({ html: fixture("js-shell.html"), finalUrl: u }));
  fakeFetch({ [url]: fixture("js-shell.html") });
  await vf.crawl({ limit: 0 });
  vf.setRenderer(null);
  assert.match(vf.load().venues.spa.lastError, /empty even in a browser/);
});

test("crawl and export skip venues marked closed", async () => {
  vf.save({ venues: { gone: { name: "Gone Review", url: "https://gone.example.org/", closed: "Closed permanently (checked 2026-10-04)", record: { name: "Gone Review", acceptsPoetry: true, confidence: "high", windows: [], yearRound: true, notes: "" } } } });
  vf.setClient(noApi);
  const calls = fakeFetch({});
  await vf.crawl({ limit: 0 });
  assert.deepEqual(calls, []);
  assert.deepEqual(vf.toDeskVenues(vf.load()), []);
});

test("toDeskVenues maps records to the desk format", () => {
  const db = { venues: {
    "lantern-street-review": { name: "Lantern Street Review", url: "https://lanternstreet.org/", guidelinesUrl: "https://lanternstreet.org/submit", checkedOn: "2026-10-01", record: {
      name: "Lantern Street Review", acceptsPoetry: true, submitMethod: "submittable", submitUrl: "https://lanternstreet.submittable.com/submit",
      feeUSD: 3, freeOption: "First 100 entries free", waiver: { kind: "email", contactEmail: "waivers@lanternstreet.org", who: "Writers facing hardship", note: "Email before the period opens", requestWindow: null },
      windows: [{ start: "01-01", end: "01-31", free: false }, { start: "07-01", end: "07-31", free: false }], yearRound: false,
      cap: null, minPoems: null, maxPoems: 4, pays: "$40 per poem", aiPolicy: "No generative AI", notes: "One document.", evidence: [], confidence: "high" } },
    "email-only": { name: "Email Only", url: "https://e.example.org", checkedOn: "2026-10-01", record: { name: "Email Only", acceptsPoetry: true, submitMethod: "email", submitEmail: "poems@e.example.org", feeUSD: null, windows: [], yearRound: true, notes: "", evidence: [], confidence: "medium" } },
    "student-route": { name: "Student Route", url: "https://s.example.edu", checkedOn: "2026-10-01", record: { name: "Student Route", acceptsPoetry: true, submitMethod: "submittable", feeUSD: 3,
      waiver: { kind: "identity", contactEmail: "journal@s.example.edu", who: "Students of the college", note: "Students may submit free by email", requestWindow: null },
      windows: [{ start: "11-13", end: "02-28", free: false }, { start: "05-01", end: "06-01", free: true }], yearRound: false, notes: "", evidence: [], confidence: "high" } },
    "closed-now": { name: "Closed Now", url: "https://c.example.org", record: { name: "Closed Now", acceptsPoetry: true, feeUSD: 0, windows: [], yearRound: false, notes: "Currently closed.", evidence: [], confidence: "high" } },
    "low": { name: "Low", url: "https://low.example.org", record: { name: "Low", acceptsPoetry: true, confidence: "low", windows: [], yearRound: true, notes: "" } },
    "fiction": { name: "Fiction Only", url: "https://f.example.org", record: { name: "Fiction Only", acceptsPoetry: false, confidence: "high", windows: [], yearRound: true, notes: "" } },
    "unextracted": { name: "Not yet", url: "https://n.example.org" }
  } };
  const out = vf.toDeskVenues(db);
  assert.deepEqual(out.map((v) => v.id).sort(), ["vf-email-only", "vf-lantern-street-review", "vf-student-route"], "drops low confidence, non-poetry, unextracted, and venues with no dates that aren't year-round");
  const l = out.find((v) => v.id === "vf-lantern-street-review");
  assert.equal(l.url, "https://lanternstreet.submittable.com/submit");
  assert.equal(l.fee, 3);
  assert.equal(l.maxPoems, 4);
  assert.equal(l.ai, "No generative AI");
  assert.equal(l.source, "venuefold");
  assert.ok(["01-01", "07-01"].includes(l.start));
  assert.deepEqual({ kind: l.waiver.kind, email: l.waiver.email }, { kind: "email", email: "waivers@lanternstreet.org" });
  assert.match(l.waiver.note, /hardship/);
  const s = out.find((v) => v.id === "vf-student-route");
  assert.equal(s.waiver.kind, "identity", "identity-only free routes are not turned into open free windows");
  assert.equal(s.waiver.start, undefined);
  assert.match(s.waiver.note, /Students of the college/);
  const e = out.find((v) => v.id === "vf-email-only");
  assert.equal(e.submitEmail, "poems@e.example.org");
  assert.equal(e.fee, 0);
  assert.equal(e.start, "");
  assert.match(e.notes, /Fee not stated/);
});
