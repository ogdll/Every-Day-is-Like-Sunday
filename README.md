# Every Day Is Like Sunday

Internal tool for the comms team: a calendar of public holidays across all DataArt office
countries, so you can find dates when nobody is out. Named after the Morrissey song — the goal
is a calendar where, ideally, every working day looks as quiet as a Sunday.

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
- Anyone signed in can add their own **events** to a day (click "+ event" on a cell, or an
  existing event to edit it). Everyone sees all events; only the person who added one can edit
  or delete it — enforced server-side against the signed-in session, not a client-sent name.
- Events are stored server-side (not per-browser) in a JSON file, via a tiny API in `server.js`
  (`/api/events`), so everyone on the team sees the same calendar. See "Persisting data" below
  for what this means on Railway.
- **Access is gated by email sign-in** (passwordless, magic-link): only addresses on an allowed
  domain (`dataart.com` by default) can get in. See "Sign-in / access control" below for setup.

No build step, no framework, no dependencies — static HTML/CSS/JS served by a tiny Node server.

## Run locally

```bash
node server.js
```

Then open http://localhost:3000. Without `BREVO_API_KEY` set, sign-in links aren't emailed —
they're printed to the server console instead, so you can still sign in while testing.

## Sign-in / access control

Only people with an email on an allowed domain can get in — no password, no account to create.
They enter their email, get a one-time link by email, click it, done (session lasts 30 days).

**Setting up Brevo** (the email sender — free tier is 300 emails/day, no time limit, plenty for
an internal tool; SendGrid's free tier, by contrast, is a 60-day trial, not permanent). Verifying
a single sender only requires confirming one inbox you control via a code emailed to it —
**no DNS/domain-admin access needed** (unlike most providers, which require verifying a whole
domain via DNS records before they'll deliver to arbitrary recipients):

1. Go to [brevo.com](https://www.brevo.com) and sign up.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender.** Fill in the sender name (e.g.
   "Every Day Is Like Sunday") and the from-email address — use an inbox you can read, e.g. your
   own `you@dataart.com` or a shared mailbox like `noreply@dataart.com` if you have one.
3. Brevo emails that inbox a confirmation code — enter it in Brevo. Done, no DNS.
4. **SMTP & API → API Keys → Generate a new API key.** Copy it — it's shown once.
5. In Railway: service → **Variables** → add `BREVO_API_KEY` with that value, and `FROM_EMAIL`
   set to **exactly** the address you verified in step 2, e.g.
   `Every Day Is Like Sunday <you@dataart.com>`.

**Environment variables** (set in Railway → service → Variables):

| Variable | Default | What it does |
| --- | --- | --- |
| `BREVO_API_KEY` | *(none)* | Required to actually send sign-in emails. Without it, links are only logged to the server console — fine for testing, not for real use. |
| `ALLOWED_EMAIL_DOMAINS` | `dataart.com` | Comma-separated list of domains allowed to sign in, e.g. `dataart.com,partner.com`. |
| `FROM_EMAIL` | *(none — required once `BREVO_API_KEY` is set)* | Must be exactly the address you verified as a Brevo sender, e.g. `Every Day Is Like Sunday <you@dataart.com>`. |
| `APP_BASE_URL` | *(derived from the request)* | The public URL Railway gives the service, e.g. `https://every-day-is-like-sunday.up.railway.app`. **Set this explicitly in production** — without it, the link emailed to people is built from the incoming request's `Host` header, which isn't a value to trust for something that ends up in an email. |

This is sign-in, not a full account system: there's no admin panel, no way to revoke one
person's access without rotating everyone's sessions (short of editing `data/sessions.json`
by hand), and anyone on the allowed domain(s) can get in. That matches "keep random people off
the internet from using this," not "fine-grained permissions" — good enough until/unless this
moves behind the company's actual intranet or SSO.

## Deploy to Railway

1. Push this folder to a GitHub repo (or use the Railway CLI directly, see below).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway's Nixpacks builder auto-detects Node from `package.json` and runs `npm start`.
3. Add the environment variables from the table above (`BREVO_API_KEY` and `FROM_EMAIL` at
   minimum).
4. Once deployed, Railway gives you a public URL (or attach your own domain in the project's
   Settings → Domains) — set that as `APP_BASE_URL`.

Or, with the [Railway CLI](https://docs.railway.com/guides/cli) from inside this folder:

```bash
railway login
railway init
railway up
```

## Persisting data

Events, sessions and display names are written to `data/*.json` (directory overridable via the
`DATA_DIR` env var). Railway's default filesystem is **ephemeral** — it's wiped on every
redeploy — so without extra setup, events disappear and everyone gets signed out on each
redeploy. To keep them:

1. In the Railway project, add a **Volume** to the service and mount it at e.g. `/data`.
2. Set the service's `DATA_DIR` environment variable to that mount path (`/data`).

Without a volume, treat events as best-effort/temporary and expect to sign in again after a
redeploy (sign-in itself still works fine either way — only the *session* is lost).

## Updating UAE/India holidays

Edit `public/custom-holidays.json`:
- `recurring` entries (`{"md": "MM-DD", "name": "..."}`) repeat every year — good for fixed-date
  holidays (e.g. National Day).
- `dates` entries (`{"date": "YYYY-MM-DD", "name": "..."}`) are one-off — use these for movable
  holidays, and update them each year from an official source.

Redeploy after editing (just push the change — Railway redeploys automatically from the
connected branch).
