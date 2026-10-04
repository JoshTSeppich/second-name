# VenueFold

Keeps the Second Name desk's venue list current. Same idea as Duotrope's listings (every venue's own
guidelines page is re-checked on a schedule) built the ProspectFold way (fetch the live page, Claude turns
it into a structured record with evidence quotes).

## Run it

    npm install
    export ANTHROPIC_API_KEY=sk-ant-...
    # optional: export VENUEFOLD_CONTACT=you@example.org (goes in the user-agent; defaults to the repo URL)
    # optional: export VENUEFOLD_MODEL=... (default claude-haiku-4-5-20251001)

    node venuefold.mjs discover          # ~300 journals from Heavy Feather Review's list + your seeds
    node venuefold.mjs crawl --limit 25  # fetch + extract; run in batches
    node venuefold.mjs status            # what changed, what failed, what's stale
    node venuefold.mjs export            # writes desk-venues.json

In the desk: You tab, "Import venues file", pick desk-venues.json. It adds and updates venues only.
Your poems, queue and any venue you added by hand are left alone.

## How it works

- discover: reads the journals section of public listing pages in sources.json, keeps entries that
  mention poetry, and adds your seed venues. Add more listing pages to "discovery" as you find them.
- crawl: for each venue due a check (default every 28 days) it checks robots.txt, waits 4 s between hits
  to the same site, fetches the page, follows a "submit/guidelines" link if the first page isn't the
  guidelines, and hashes the text. Unchanged page: no Claude call, just a new check date. Changed page:
  Claude extracts fee, free routes, fee waivers (who, how, contact, request dates), reading windows,
  caps, poem limits, pay, AI policy and short evidence quotes, and the previous record is kept in history.
- export: drops low-confidence and non-poetry records, picks the current or next window, and maps the
  rest to the desk's venue format. "Fee not stated" is flagged in the notes rather than guessed.

## Tests

    npm test    # node --test against saved pages in test/fixtures; no network, no API

## Limits

- A venue that has shut down: set `"closed": "why, and when you checked"` on it in data/venues.json.
  Crawl and export skip it, and discover won't re-add it.
- Pages built entirely by JavaScript come back empty; they're reported as errors. Add a
  "guidelinesUrl" for that venue in data/venues.json pointing at a plain page (often the Submittable link).
- It reads venues' own public pages and one free community list. It does not scrape Duotrope or
  Chill Subs: their listings are their work and their terms forbid it.
- Cost: one Claude call per changed page, a few thousand tokens each. The 28-day hash check keeps
  repeat runs cheap.
- Extraction can still be wrong. The desk's review step asks you to confirm the venue's page before
  you pay; keep it that way.
