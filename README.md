# Trinity Securities Limited — Offers Portal

A Node.js/Express public offers (share subscription) portal for Trinity Securities Limited,
modelled on the same 3-step flow used by Meristem's Offers Portal: **Security → Account
(BVN/NIN) → Participation (shares + payment)**.

## Stack

- Node.js + Express, EJS views, Tailwind CSS (compiled locally — no CDN dependency, so the
  portal renders correctly even with no internet access)
- better-sqlite3 for storage (a single embedded `dev.db` file, zero external services to run)
- Session-based flow state (`express-session`) + `connect-flash` for messages

## Getting started

```bash
npm install
cp .env.example .env      # edit values as needed (bank details, admin login, etc.)
npm run seed              # creates an admin user + one demo offer
npm start                 # builds the Tailwind CSS, then starts the server
```

Visit `http://localhost:3000` for the public portal and `http://localhost:3000/admin` for
the back office (login printed by `npm run seed`, default `admin@trinitysecuritiesltd.com` /
`ChangeMe123!` — **change this password on first login**, it's only a seed default).

Use `npm run dev` instead of `npm start` while developing (auto-restarts on file changes via
nodemon). If you change Tailwind classes and want live rebuilds, run `npm run watch:css` in a
second terminal.

## What's real vs. mocked right now

This scaffold is deliberately built so every "needs a live contract" piece sits behind one
small file, so you can wire in real providers without touching the rest of the app:

| Piece | File | Current state |
|---|---|---|
| BVN / minor NIN verification | `src/services/verification.js` | **Mocked** — any well-formed 11-digit number verifies successfully. Swap in Youverify/Prembly/Smile Identity/VerifyMe/NIBSS once you have a KYC contract; nothing else needs to change. |
| OTP for the Security step | `src/services/otp.js` | **Mocked** — a real code is generated but handed back in the response (`devCode`) instead of being texted/emailed. Wire up an SMS/email provider (Termii, Africa's Talking, etc.) and delete the `devCode` field. |
| Payment | Bank transfer only | Subscribers transfer to the **static** account in `.env` (`BANK_NAME` / `BANK_ACCOUNT_NUMBER` / `BANK_ACCOUNT_NAME`) and quote a unique reference (`TSL-XXXXXXXX`) as narration; an admin manually confirms once the transfer lands and reconciles by reference + amount. A card/online-payment option (e.g. Paystack) or a real bank webhook can replace the manual "I've Made the Transfer" step later. |
| "Pay with [trading platform]" login | Not included | The reference screenshots show a second option that submits a username/password for the broker's own trading platform. That pattern is worth avoiding even once InfoWARE/Trinity's platform is ready — see note below. |

## A security note on the "pay with platform credentials" pattern

The reference design includes a screen asking subscribers to type their trading-platform
username and password directly into the offers portal to "authorise payment." That's a
password-collection surface on a second application, which is exactly the shape of a
credential-phishing page even when both apps are legitimately yours — a bad habit to build
into production. If/when Trinity Securities' own retail platform is ready, prefer an
OAuth-style redirect/token flow (the portal redirects to the platform to authorize, and gets a
token back) over collecting the raw password here.

## Data protection

BVN and NIN are sensitive identifiers under the NDPA 2023. Before taking this beyond a demo:

- Point `VERIFICATION_MODE` at a licensed KYC provider rather than shipping the mock.
- Encrypt `dev.db` at rest (or move to Postgres/MySQL with disk encryption) once real BVNs/NINs
  are stored — `src/db.js` is the only file that would need to change.
- Put this behind HTTPS and set a strong, random `SESSION_SECRET`.
- Review your NDPA consent/retention obligations for the data this app collects.

## Project layout

```
src/
  server.js            Express app setup
  db.js                All data access (SQLite via better-sqlite3)
  routes/
    public.js           Home + offer detail + "start subscription"
    subscribe.js         The 3-step flow (Security / Account / Participation)
    admin.js             Admin auth, offers CRUD, subscriptions review
    api.js               Inline BVN/NIN verify endpoints (fetch() calls from the Account step)
  services/
    verification.js      BVN/NIN verification (mocked, pluggable)
    otp.js                OTP generation/verification (mocked, pluggable)
    reference.js          Generates the TSL-XXXXXXXX bank transfer reference
  middleware/            Admin auth guard + subscription-flow step guard
  views/                 EJS templates (Tailwind classes)
  public/                Static assets: logo, compiled CSS, client-side JS
  seed.js                Creates the admin user + one demo offer
```

## Managing offers

Sign in at `/admin`, then **New Offer** to create a public offer (price per share, minimum/
multiple/maximum shares, closing date, prospectus/term sheet/pricing supplement links), and
**Subscriptions** to review incoming subscriptions and confirm payments once a transfer has
been reconciled against its reference.
