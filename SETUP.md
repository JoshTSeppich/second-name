# Second Name: setup

Two parts, about 20 minutes. You need a GitHub account and an Anthropic API key (for the weekly venue
updates). Each person using the app also needs their own AI key, entered on their phone the first time
they open it.

## 1. Put the app online (10 min)

1. Fork or create a GitHub repo named `second-name` and push this folder to it. Public is simplest;
   GitHub Pages on a private repo needs a paid plan. The repo holds no poems, keys or personal data: those
   live only on each phone.
2. Repo Settings > Pages > Source: "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
3. After a minute the app is at `https://<your-username>.github.io/second-name/`.

**Install on iPhone:** open that link in Safari > Share > Add to Home Screen. It opens full-screen, with
its own icon, and works offline. Send your collaborator the same link.

**First run:** the app asks for an AI key (Anthropic or OpenAI) before anything else. Follow the link on
that screen to create a key, paste it, press Verify. The key stays on that phone.

Note: a phone keeps its own data. The home-screen app starts a fresh desk, separate from anything typed
in Safari. Use You > "Copy everything as text" to move a desk over (the AI key is never included).

## 2. Turn on weekly venue updates (10 min)

1. Repo Settings > Secrets and variables > Actions > New repository secret.
   Name `ANTHROPIC_API_KEY`, value your key. (Or: `gh secret set ANTHROPIC_API_KEY` and paste it.)
2. Optional: in `venuefold/sources.json`, `contact` goes in VenueFold's user-agent so a venue's webmaster
   can reach you. It defaults to the repo URL. To use an email without committing it, set a repository
   variable `VENUEFOLD_CONTACT` (Settings > Secrets and variables > Actions > Variables).
3. Actions tab > "VenueFold weekly refresh" > Run workflow. The first run takes 20 to 40 minutes.
   After that it runs every Monday and re-checks each venue every 28 days, up to 80 venues a run.
4. When it finishes, `venues/desk-venues.json` is updated. The app picks it up next time it opens and
   shows "Venues refreshed".

Cost: one Claude Haiku call per venue whose page changed (unchanged pages cost nothing). Set a monthly
spend limit in the Anthropic Console (Settings > Limits) before the first run. To use a different model,
set a repository variable `VENUEFOLD_MODEL`.

## What runs where

| Piece | Where | What it costs |
|---|---|---|
| The app | GitHub Pages | free |
| Your poems, queue, chat, AI key | each phone, in the app's storage | free |
| Copilot | your phone, calling your AI provider directly | your provider's per-token rates |
| Venue updates | GitHub Actions, Mondays | free runner minutes + Claude calls |
| Tests | GitHub Actions, every push | free runner minutes, no API calls |

## Not done yet

- Sync between phones. Each phone is its own desk.
- App Store. This is an installable web app. A native wrapper is possible later for notifications when
  windows open.
