#!/usr/bin/env node
// VenueFold: keeps a poetry-venue dataset current the way Duotrope does (re-check every venue's own
// guidelines page on a schedule) and the way ProspectFold does (fetch the live page, have Claude turn it
// into a structured record, keep the evidence). Output imports straight into the Second Name desk.
//
//   node venuefold.mjs discover            pull candidate venues from public listing pages (sources.json)
//   node venuefold.mjs crawl [--limit 20] [--only "Rattle"] [--force] [--dry-run]
//   node venuefold.mjs export              write desk-venues.json for the desk's Import box
//   node venuefold.mjs status              what's stale, what changed, what failed
//
// Needs ANTHROPIC_API_KEY for crawl (not for --dry-run). Data lives in data/venues.json.
// Pages built by JavaScript are rendered in headless Chromium when Playwright is installed (VENUEFOLD_RENDER=0 turns it off).
// Env overrides: ANTHROPIC_WORKSPACE_ID (multi-workspace keys), VENUEFOLD_MODEL, VENUEFOLD_CONTACT, VENUEFOLD_STORE (data file), VENUEFOLD_DELAY_MS.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.VENUEFOLD_STORE || path.join(DIR, "data", "venues.json");
const SOURCES = path.join(DIR, "sources.json");
const CFG = JSON.parse(fs.readFileSync(SOURCES, "utf8"));
export const MODEL = process.env.VENUEFOLD_MODEL || CFG.model || "claude-haiku-4-5-20251001";
const UA = `VenueFold/0.1 (personal poetry submission tracker; ${process.env.VENUEFOLD_CONTACT || CFG.contact || "no contact set"})`;
const RECHECK_DAYS = CFG.recheckDays ?? 28;          // Duotrope re-checks guidelines every four weeks
const PER_DOMAIN_DELAY_MS = process.env.VENUEFOLD_DELAY_MS != null ? +process.env.VENUEFOLD_DELAY_MS : CFG.perDomainDelayMs ?? 4000;
const MAX_PAGE_CHARS = 24000;

// ---------- store ----------
export function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { venues: {} }; }
}
export function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(STORE + ".tmp", STORE);
}
const keyOf = (name) => name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- polite fetching ----------
const lastHit = new Map();
const robotsCache = new Map();
async function robotsAllows(u) {
  const { origin, pathname } = new URL(u);
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await fetch(origin + "/robots.txt", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        let applies = false;
        for (const raw of (await r.text()).split("\n")) {
          const line = raw.split("#")[0].trim(); if (!line) continue;
          const [k, ...rest] = line.split(":"); const v = rest.join(":").trim();
          if (/^user-agent$/i.test(k)) applies = v === "*" || /venuefold/i.test(v);
          else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
        }
      }
    } catch { /* unreachable robots.txt: treat as allowed */ }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some((p) => pathname.startsWith(p));
}
async function waitTurn(u) {
  if (!(await robotsAllows(u))) throw new Error("blocked by robots.txt");
  const host = new URL(u).host, wait = (lastHit.get(host) || 0) + PER_DOMAIN_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}
async function politeFetch(u) {
  await waitTurn(u);
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { html: await r.text(), finalUrl: r.url };
}
// Pages built by JavaScript (Wix, Blogger, Squarespace...) come back nearly empty from a plain fetch. Those
// get one more try in headless Chromium, if Playwright and its browser are installed. VENUEFOLD_RENDER=0 turns
// this off. Returns null when rendering isn't available.
let renderer = null, browser = null;
export function setRenderer(fn) { renderer = fn; }
async function renderPage(u) {
  if (renderer) return renderer(u);
  if (process.env.VENUEFOLD_RENDER === "0") return null;
  if (!browser) {
    try { const { chromium } = await import("playwright"); browser = await chromium.launch(); }
    catch { process.env.VENUEFOLD_RENDER = "0"; return null; }
  }
  await waitTurn(u);
  const ctx = await browser.newContext({ userAgent: UA }), p = await ctx.newPage();
  try {
    await p.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
    await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    let body = "";                                   // every frame, so old frameset sites read too
    for (const f of p.frames()) body += await f.evaluate(() => (document.body ? document.body.innerHTML : "")).catch(() => "");
    const title = (await p.title()).replace(/[<&]/g, " ");
    return { html: `<html><head><title>${title}</title></head><body>${body}</body></html>`, finalUrl: p.url() };
  } finally { await ctx.close(); }
}
export async function closeRenderer() { if (browser) { await browser.close(); browser = null; } }

export function pageText(html, base) {
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, a) => {
    try { links.push({ text: $(a).text().trim().slice(0, 80), href: new URL($(a).attr("href"), base).href }); } catch {}
  });
  $("script,style,noscript,svg,iframe,header nav,footer").remove();
  const title = $("title").text().trim();
  const text = $("body").text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const emails = [...new Set((html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()))];
  // obfuscated "editor [at] example [dot] org"
  for (const m of text.matchAll(/([a-z0-9._-]+)\s*[\[(]\s*at\s*[\])]\s*([a-z0-9-]+)\s*[\[(]\s*dot\s*[\])]\s*([a-z.]{2,})/gi)) emails.push(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  const junk = /^(user|name|you|email|example)@(domain|example|email)\./;
  return { title, text, links, emails: [...new Set(emails)].filter((e) => !junk.test(e) && !/\.(png|jpg|gif|webp)$/.test(e)) };
}
const looksLikeGuidelines = (t) => /(submission|submit|reading period|guidelines)/i.test(t) && /(poem|poetry)/i.test(t);
function guidelineLinks(links, base) {
  const host = new URL(base).host.replace(/^www\./, "");
  return links.filter((l) => /submi|guideline|contribut/i.test(l.text + " " + l.href))
    .filter((l) => l.href.includes(host) || /submittable\.com|duosuma|moksha/.test(l.href))
    .map((l) => l.href.split("#")[0]).filter((h, i, a) => a.indexOf(h) === i && h !== base).slice(0, 3);
}

// ---------- extraction ----------
const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    acceptsPoetry: { type: "boolean" },
    submitMethod: { type: "string", enum: ["submittable", "web_form", "email", "post", "other", "unknown"] },
    submitUrl: { type: ["string", "null"] },
    submitEmail: { type: ["string", "null"] },
    feeUSD: { type: ["number", "null"], description: "Standard general-submission fee for poetry. 0 if explicitly free. null if not stated." },
    freeOption: { type: ["string", "null"], description: "Any free route: free category, free days, free until a cap, subscriber route, etc." },
    waiver: {
      type: ["object", "null"],
      properties: {
        kind: { type: "string", enum: ["email", "form", "option", "window", "identity", "unknown"] },
        contactEmail: { type: ["string", "null"] },
        who: { type: ["string", "null"], description: "Who qualifies, in the venue's terms" },
        requestWindow: { type: ["string", "null"], description: "Dates when waiver requests are accepted, if stated" },
        note: { type: "string" }
      },
      required: ["kind", "note"]
    },
    windows: {
      type: "array", description: "Poetry reading periods. Month-day form, recurring yearly. Empty if rolling/year-round.",
      items: {
        type: "object",
        properties: { start: { type: "string", pattern: "^\\d{2}-\\d{2}$" }, end: { type: "string", pattern: "^\\d{2}-\\d{2}$" }, free: { type: "boolean" }, label: { type: "string" } },
        required: ["start", "end", "free"]
      }
    },
    yearRound: { type: "boolean" },
    cap: { type: ["string", "null"], description: "Submission cap, e.g. '300 per month'" },
    minPoems: { type: ["integer", "null"] },
    maxPoems: { type: ["integer", "null"] },
    maxPages: { type: ["integer", "null"] },
    pays: { type: ["string", "null"] },
    simultaneous: { type: ["boolean", "null"] },
    aiPolicy: { type: ["string", "null"], description: "Verbatim-short summary of any AI policy" },
    responseTime: { type: ["string", "null"] },
    notes: { type: "string", description: "One or two plain sentences a poet needs: format rules, one-submission-per-period, eligibility limits." },
    evidence: { type: "array", items: { type: "string" }, description: "Up to 5 short quotes (under 20 words each) from the page backing fee, window and waiver facts" },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: ["name", "acceptsPoetry", "submitMethod", "windows", "yearRound", "notes", "evidence", "confidence"]
};
const PROMPT = (venue, url, page) => `You are extracting submission facts for poets from a literary venue's own web page.
Today is ${today()}. Venue as listed elsewhere: "${venue}". Page URL: ${url}
Rules:
- Use ONLY what this page states. Unknown means null. Never guess fees, dates or caps.
- Poetry only: ignore fiction, art and contest-only details unless they change how poems are submitted.
- Contests with entry fees are NOT the general fee; report the general submission route.
- Dates: convert reading periods to MM-DD recurring windows. "January" = 01-01 to 01-31.
- Fee waivers: capture who qualifies, how to ask (email/form), the contact, and any dates requests are accepted.
- Emails found on the page (may include obfuscated ones): ${page.emails.join(", ") || "none"}
Call record_venue exactly once.

PAGE TITLE: ${page.title}
PAGE TEXT:
${page.text.slice(0, MAX_PAGE_CHARS)}`;

let client;
export function setClient(c) { client = c; }
async function extract(venue, url, page) {
  // A key that spans several workspaces needs the workspace named on every request.
  client ||= new Anthropic(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {});
  const req = {
    model: MODEL, max_tokens: 2000,
    tools: [{ name: "record_venue", description: "Record the structured submission facts for this venue.", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "record_venue" },
    messages: [{ role: "user", content: PROMPT(venue, url, page) }]
  };
  let res;
  try { res = await client.messages.create(req); }
  catch (e) {
    // Some newer models (set via VENUEFOLD_MODEL) reject forced tool choice; fall back to auto.
    if (e?.status !== 400 || !/tool_choice/.test(e?.message || "")) throw e;
    res = await client.messages.create({ ...req, tool_choice: { type: "auto" } });
  }
  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) throw new Error("no structured record returned");
  return call.input;
}

// ---------- commands ----------
export async function discover() {
  const db = load(); let added = 0;
  for (const src of CFG.discovery || []) {
    console.log("discover:", src.url);
    let html; try { ({ html } = await politeFetch(src.url)); } catch (e) { console.log("  skipped:", e.message); continue; }
    const $ = cheerio.load(html);
    let scope = $("p, li");
    if (src.section) {
      const head = $("h1,h2,h3,h4").filter((_, h) => $(h).text().includes(src.section)).first();
      scope = head.length ? head.nextUntil("h1,h2,h3").filter("p, li").add(head.nextUntil("h1,h2,h3").find("p, li")) : scope;
    }
    scope.each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim(), a = $(el).find("a[href]").first();
      if (!a.length || !/poetry/i.test(t) || t.length > 600) return;
      const name = a.text().replace(/\s+/g, " ").trim().replace(/\s*[—–-]\s*$/, "");
      if (!name || name.length > 90) return;
      let href; try { href = new URL(a.attr("href"), src.url).href; } catch { return; }
      if (new URL(href).host === new URL(src.url).host) return;     // skip the listing site's own links
      const k = keyOf(name);
      if (!db.venues[k]) { db.venues[k] = { name, url: href, discoveredFrom: src.url, listing: t.slice(0, 300), addedOn: today() }; added++; }
    });
  }
  for (const s of CFG.seeds || []) { const k = keyOf(s.name); if (!db.venues[k]) { db.venues[k] = { ...s, addedOn: today() }; added++; } }
  save(db); console.log(`discover: ${added} new, ${Object.keys(db.venues).length} total`);
}

export async function crawl(opts) {
  const db = load(); let n = 0, changed = 0, same = 0, failed = 0;
  const due = Object.entries(db.venues).filter(([, v]) => {
    if (v.closed) return false;                      // set by hand when a venue has shut down; never re-fetched
    if (v.manual) return false;                      // site refuses automated reading; its desk entry is kept by hand
    if (opts.only && !v.name.toLowerCase().includes(opts.only.toLowerCase())) return false;
    if (opts.force || !v.checkedOn) return true;
    return (Date.now() - new Date(v.checkedOn)) / 864e5 >= RECHECK_DAYS;
  }).slice(0, opts.limit || Infinity);
  for (const [k, v] of due) {
    n++; process.stdout.write(`[${n}/${due.length}] ${v.name} ... `);
    try {
      let url = v.guidelinesUrl || v.url, { html, finalUrl } = await politeFetch(url), page = pageText(html, finalUrl);
      if (!looksLikeGuidelines(page.text)) {
        for (const g of guidelineLinks(page.links, finalUrl)) {
          try { const r = await politeFetch(g); const p2 = pageText(r.html, r.finalUrl); if (looksLikeGuidelines(p2.text)) { url = r.finalUrl; page = p2; break; } } catch {}
        }
      } else url = finalUrl;
      if (page.text.length < 300) {
        // Render the page; if it isn't the guidelines, render up to 3 submission links found on it.
        const first = await renderPage(url);
        if (first) {
          const p1 = pageText(first.html, first.finalUrl);
          if (p1.text.length >= 300) { page = p1; url = first.finalUrl; }
          if (!looksLikeGuidelines(p1.text)) {
            for (const g of guidelineLinks(p1.links, first.finalUrl)) {
              const r = await renderPage(g); const p2 = r && pageText(r.html, r.finalUrl);
              if (p2 && p2.text.length >= 300 && looksLikeGuidelines(p2.text)) { page = p2; url = r.finalUrl; break; }
            }
          }
        }
        if (page.text.length < 300) throw new Error(first
          ? "page is mostly empty even in a browser; open it yourself or add a guidelinesUrl by hand"
          : "page is mostly empty here (built by JavaScript) and the browser fallback isn't available; install Playwright or add a guidelinesUrl by hand");
      }
      const hash = sha(page.text);
      if (hash === v.pageHash && !opts.force) { v.checkedOn = today(); v.lastError = null; same++; console.log("unchanged"); continue; }
      if (opts.dryRun) { console.log(`would extract (${page.text.length} chars from ${url}, emails: ${page.emails.join(", ") || "none"})`); continue; }
      const rec = await extract(v.name, url, page);
      v.history = [...(v.history || []), ...(v.record ? [{ on: v.checkedOn, record: v.record }] : [])].slice(-3);
      Object.assign(v, { record: rec, guidelinesUrl: url, pageHash: hash, checkedOn: today(), lastError: null, changedOn: today() });
      changed++; console.log(`ok (${rec.confidence}${rec.feeUSD != null ? ", $" + rec.feeUSD : ""}${rec.waiver ? ", waiver: " + rec.waiver.kind : ""})`);
    } catch (e) { v.lastError = `${today()}: ${String(e.message).split("\n")[0]}`; failed++; console.log("failed:", e.message); }
    finally { save(db); }
  }
  await closeRenderer();
  console.log(`crawl: ${changed} updated, ${same} unchanged, ${failed} failed`);
}

export function nextWindow(wins, wantFree) {
  const now = new Date(), md = (d) => String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const t = md(now), list = wins.filter((w) => (wantFree == null ? true : !!w.free === wantFree));
  const open = list.find((w) => (w.start <= w.end ? t >= w.start && t <= w.end : t >= w.start || t <= w.end));
  if (open) return open;
  return [...list].sort((a, b) => ((a.start >= t ? "" : "1") + a.start).localeCompare((b.start >= t ? "" : "1") + b.start))[0] || null;
}
export function toDeskVenues(db) {
  const out = [];
  for (const [k, v] of Object.entries(db.venues)) {
    const r = v.record; if (v.closed || v.manual || !r || !r.acceptsPoetry || r.confidence === "low") continue;
    // No windows and not year-round means closed now or dates not stated. The desk reads blank dates as
    // "open year-round", so leave these out until a later check finds dates.
    if (!r.yearRound && !(r.windows || []).length) { out.skipped = (out.skipped || 0) + 1; continue; }
    const w = r.yearRound ? null : nextWindow(r.windows || []);
    const freeW = (r.windows || []).length > 1 ? nextWindow(r.windows, true) : null;
    let waiver = null;
    if (r.waiver) waiver = { // "identity" stays as is: those routes are only for certain writers, so they must not read as open free windows.
    kind: r.waiver.kind === "form" ? "window" : r.waiver.kind, email: r.waiver.contactEmail || undefined, note: [r.waiver.who, r.waiver.note, r.waiver.requestWindow && "Requests: " + r.waiver.requestWindow].filter(Boolean).join(". ") };
    else if (r.freeOption && r.feeUSD) waiver = { kind: "option", note: r.freeOption };
    if (waiver && waiver.kind !== "identity" && freeW && w !== freeW) Object.assign(waiver, { kind: "window", start: freeW.start, end: freeW.end });
    out.push({
      id: "vf-" + k, name: r.name || v.name, url: r.submitUrl || v.guidelinesUrl || v.url,
      submitEmail: r.submitMethod === "email" ? r.submitEmail || undefined : undefined,
      fee: r.feeUSD ?? 0, start: w ? w.start : "", end: w ? w.end : "",
      tags: "general", minPoems: r.minPoems || undefined, maxPoems: r.maxPoems || 3,
      pays: r.pays || undefined, ai: r.aiPolicy || undefined, checked: v.checkedOn,
      notes: [r.notes, r.cap && "Cap: " + r.cap, r.responseTime && "Response: " + r.responseTime, r.feeUSD == null && "Fee not stated on their page; check before paying."].filter(Boolean).join(" "),
      waiver: waiver || undefined, source: "venuefold"
    });
  }
  return out;
}
export function exportDesk() {
  const out = toDeskVenues(load());
  const file = path.join(DIR, "desk-venues.json");
  fs.writeFileSync(file, JSON.stringify({ venuefold: 1, exportedOn: new Date().toISOString(), venues: out }, null, 1));
  console.log(`export: ${out.length} venues -> ${file}${out.skipped ? ` (${out.skipped} left out: closed now or no dates stated)` : ""}\nIn the desk: You tab -> Import venues -> pick this file.`);
}
function status() {
  const db = load(), all = Object.values(db.venues), vs = all.filter((v) => !v.closed && !v.manual), stale = vs.filter((v) => !v.checkedOn || (Date.now() - new Date(v.checkedOn)) / 864e5 >= RECHECK_DAYS);
  console.log(`${vs.length} venues (${all.filter((v) => v.closed).length} closed, ${all.filter((v) => v.manual).length} checked by hand) | ${vs.filter((v) => v.record).length} extracted | ${stale.length} due for a check | ${vs.filter((v) => v.lastError).length} with errors`);
  for (const v of vs.filter((v) => v.changedOn === today())) console.log("  changed today:", v.name);
  for (const v of vs.filter((v) => v.lastError).slice(0, 15)) console.log("  error:", v.name, "-", v.lastError);
  for (const v of all.filter((v) => v.manual)) console.log("  check by hand:", v.name, "-", v.manual);
}

// Run as a command only when executed directly, so tests can import the functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const [cmd, ...argv] = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
const opts = { limit: +opt("--limit") || 0, only: opt("--only"), force: argv.includes("--force"), dryRun: argv.includes("--dry-run") };
if (cmd === "discover") await discover();
else if (cmd === "crawl") await crawl(opts);
else if (cmd === "export") exportDesk();
else if (cmd === "status") status();
else console.log("usage: node venuefold.mjs discover | crawl [--limit N] [--only NAME] [--force] [--dry-run] | export | status");
}
