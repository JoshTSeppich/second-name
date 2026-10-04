# Second Name

Second Name is a submission desk for poets, built for a phone. It keeps your poems, a list of journals,
their reading periods and fees, and the packets you're getting ready to send. It was made for two poets
who share the work of sending poems out. The app is free; the copilot runs on your own AI key, so you
pay the AI provider directly for what you use.

Open it at **https://joshtseppich.github.io/second-name/**

## What it tries to do

- **Submit for as little money as possible.** Free venues come first, then venues that waive fees, then
  paid ones. Where a venue waives fees on request, one tap opens a polite waiver email, already filled in.
  You set a fee budget and the app won't let you approve a packet that goes over it.
- **Never miss a window.** A calendar shows when reading periods open and close, which venues cap
  submissions (so you should go on day one), and when free windows open.
- **A person approves every submission.** The app prepares packets. It never pays and never submits.
  You open the venue's page, paste, pay if there's a fee, and press submit yourself.
- **The poems are yours.** The copilot critiques. It doesn't write or rewrite your poems unless you ask
  for that exact thing, and it labels anything it suggests as its own. Many journals ban AI-written or
  AI-assisted work, and you should always be able to say truthfully which words are yours. Packets are
  scrubbed of hidden characters (zero-width spaces, direction marks and similar) before you copy them.
- **Keep venue information current.** VenueFold, a small crawler, re-reads each venue's own guidelines
  page every week and updates the list.

## A tour

**Desk.** Your packets, grouped as *ready to review*, *waiting for a window* and *sent*. *Prepare packets*
finds venues that are open now or open soon, cheapest first, picks the poems whose themes fit best and
drafts a cover note. Open a packet to review it: change the poems, request a fee waiver, read the six
checks (poem count, name, bio, window, budget, submission route), edit the note, read the full packet,
and tick two boxes. Only then does the approve button unlock. It copies the packet and opens the venue's
page (or your mail app, for venues that take email).

**Poems.** Your poems, with title, author, a "second name" (the title a reader would give it), themes
and the text. Log revisions to keep a weekly rhythm.

**Copilot.** A chat that has read every poem, venue and packet on your desk. Ask for a blunt critique,
which poems suit which journal, or whether a waiver is worth asking for. It can save a poem you paste,
rename poems, set second names, and change which poems a packet carries. It can't pay or submit.

**Dates.** A calendar of openings, closings and free windows for the next six months, with
"Add to Google Calendar" links, plus the full venue list. You can add venues by hand.

**You.** Your name, bio and one line about the work (these go on every packet), the fee budget,
autopilot settings, your AI key, venue import, and sharing.

## Honest limits

- **No auto-submit, ever.** That's on purpose.
- **No sync between phones yet.** Each phone keeps its own desk in the browser's storage. To hand
  everything to your collaborator, use You > *Copy everything as text* and send it; they paste it on their
  phone. (Your AI key is never included in that copy.)
- **Venue data can be wrong.** VenueFold reads venues' own pages, but pages change and extraction makes
  mistakes. Always check the venue's page for the window, fee and limits before you pay. The approval
  step asks you to confirm you did.
- **The AI line.** The copilot is a reader, not a co-author. If a journal bans AI-assisted work, read its
  policy (shown on each venue when known) and decide for yourself whether talking poems over with the
  copilot is OK for that journal.
- **Clearing your browser data clears the desk.** Copy everything as text now and then as a backup.

## Install on iPhone

1. Open https://joshtseppich.github.io/second-name/ in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.

It opens full screen with its own icon and works offline after the first visit. Note: the home-screen
app keeps its own storage, separate from Safari, so set it up from the home-screen icon.

## Getting an API key

The first screen asks for an AI key. You need an account with one of:

- **Anthropic (Claude):** create a key at https://platform.claude.com/settings/keys.
  The app uses Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) by default.
- **OpenAI:** create a key at https://platform.openai.com/account/api-keys.
  The app uses GPT-6 Luna (`gpt-6-luna`) by default, OpenAI's lowest-cost current model with function
  calling.

New accounts usually need some prepaid credit before a key works. Paste the key and press **Verify**.
The app checks it by listing the provider's models, which doesn't cost anything. The key is stored only
on that phone, sent only to the provider, and never put in exports or in this repository. You can change
or remove it in the You tab. You > Advanced lets you pick a different model.

**What it costs.** You pay the provider per token (a token is roughly three quarters of a word). Rates
are on their pricing pages:
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) ·
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).
As listed in October 2026, Claude Haiku 4.5 is $1 per million input tokens and $5 per million output
tokens, and GPT-6 Luna is $0.10 and $0.50. Each copilot message sends the whole desk (your poems and the
venue list), so the input side grows with the size of your desk. Set a monthly spend limit in your
provider account.

Note: Anthropic's models page lists Claude Haiku 4.5's retirement as "not sooner than October 15, 2026".
If Anthropic retires it, the copilot will say it doesn't recognise the model; enter a current model in
You > Advanced (and change the default in `index.html` and `venuefold/sources.json`).

## How VenueFold works

VenueFold (`venuefold/`) runs every Monday in GitHub Actions:

1. **Discover**: reads a free public list of journal calls and the seed venues in `sources.json`.
2. **Crawl**: for each venue not checked in the last 28 days, it checks robots.txt, waits between requests
   to the same site, fetches the venue's own guidelines page and hashes the text. If the page hasn't
   changed, it just updates the check date: no AI call. If it changed, Claude (Haiku 4.5 by default)
   extracts fee, free routes, fee waivers, reading windows, caps, poem limits, pay, AI policy and short
   evidence quotes. Up to 80 venues a run.
3. **Export**: drops low-confidence and non-poetry records and writes `venues/desk-venues.json`.

The app fetches that file when it opens and shows "Venues refreshed". Venues you added or edited by hand
are left alone. It does not scrape Duotrope or Chill Subs. More detail in `venuefold/README.md`.

## For developers

The app is one file, `index.html`: vanilla JavaScript, no build step, data in `localStorage`. It's a PWA
(`manifest.webmanifest`, `sw.js`) hosted on GitHub Pages from `main`, root folder. Bump `CACHE` in
`sw.js` when you ship so installed copies pick up the change.

AI calls go straight from the browser to the provider. Anthropic needs the
`anthropic-dangerous-direct-browser-access: true` header for that; OpenAI's API allows browser requests.
Both providers sit behind one small adapter (`PROVIDERS` and `aiSample` in `index.html`) that runs the
copilot's tool loop (`addPoem`, `updatePoem`, `setPacketPoems`, at most 4 model calls) and maps errors to
plain messages.

```sh
npm install                 # Playwright, for the app tests
npx playwright install chromium
npm --prefix venuefold install

npm run serve               # http://localhost:4173/
npm test                    # VenueFold unit tests, then the Playwright tests
```

- `tests/app.spec.mjs`: Playwright, against the app served locally, with both provider APIs mocked.
  Covers onboarding and key verification outcomes, export safety, removing the key, the copilot tool loop
  on both providers, venue import and offline loading.
- `venuefold/test/`: Node's built-in test runner against saved HTML fixtures. No network, no API.
- `.github/workflows/test.yml` runs both on every push. `.github/workflows/venuefold.yml` is the weekly
  crawl and needs the `ANTHROPIC_API_KEY` repository secret.

See `SETUP.md` to run your own copy.
