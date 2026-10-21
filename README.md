# Holiday Scheduler

Internal tool for the comms team: a calendar of public holidays across all DataArt office
countries, so you can find dates when nobody is out.

- Default countries = DataArt offices (from dataart.com/contact-us): US, Mexico, UK, Switzerland,
  Germany, Cyprus, Latvia, Poland, Romania, Serbia, Bulgaria, Ukraine, Georgia, Armenia,
  Kazakhstan, UAE, India. Each can be toggled on/off, and any other country can be added.
- Holiday data is fetched live, client-side, from the free [date.nager.at](https://date.nager.at)
  public holidays API (no key needed). UAE and India aren't covered by that API — their holidays
  come from [`public/custom-holidays.json`](public/custom-holidays.json), which you maintain by
  hand (see the `_readme` field in that file for how to update it, especially movable holidays
  like Eid or Diwali).
- "Next holiday-free weekdays" and the calendar highlight days when **none** of the selected
  countries have a holiday — that's the window to schedule activities in.

No build step, no framework, no dependencies — static HTML/CSS/JS served by a tiny Node server.

## Run locally

```bash
node server.js
```

Then open http://localhost:3000.

## Deploy to Railway

1. Push this folder to a GitHub repo (or use the Railway CLI directly, see below).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway's Nixpacks builder auto-detects Node from `package.json` and runs `npm start`.
   No extra configuration is needed — no database, no env vars.
3. Once deployed, Railway gives you a public URL (or attach your own domain in the project's
   Settings → Domains).

Or, with the [Railway CLI](https://docs.railway.com/guides/cli) from inside this folder:

```bash
railway login
railway init
railway up
```

## Updating UAE/India holidays

Edit `public/custom-holidays.json`:
- `recurring` entries (`{"md": "MM-DD", "name": "..."}`) repeat every year — good for fixed-date
  holidays (e.g. National Day).
- `dates` entries (`{"date": "YYYY-MM-DD", "name": "..."}`) are one-off — use these for movable
  holidays, and update them each year from an official source.

Redeploy after editing (just push the change — Railway redeploys automatically from the
connected branch).
