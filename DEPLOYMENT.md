# Deploying the Offers Portal to cPanel (AlmaLinux, no CloudLinux)

Same process used for `nextprodigybank` (see that project's `DEPLOYMENT.md`): this box has
**no CloudLinux "Setup Node.js App" selector**, so the app runs as a plain Node process
managed by **PM2**, bound to `127.0.0.1:<port>`, with **Apache reverse-proxying** the domain
to it. Everything below is done over **SSH**.

- **cPanel user:** `admintsl` → home `/home/admintsl`
- **Domain:** `ipo.trinitysecuritiesltd.com`
- **App root:** `~/ipo-portal` — kept **outside** `public_html` on purpose (unlike the
  prodigy-bank deploy). The proxy targets a port, not a path, so there's no need to put the
  source under the web root at all — this removes the `.htaccess`/source-exposure trick
  entirely, since Apache's document root never points anywhere near the app folder.
- **Deploy artifact:** zip/tar of the repo **excluding** `node_modules/`, `.git/`, and any
  `dev.db*` files (fresh DB gets created by the seed step below).

> Requires **root/WHM** for Steps 1, 3 (boot persistence) and 4. Steps 2–3 (minus boot
> persistence) run as `admintsl`.

---

## 1 — Node runtime (as root)
Check what's already installed first — other sites on this box may already have a suitable
Node version, in which case skip straight to Step 2:
```bash
node -v
```
If missing or too old (this app needs Node **>= 18**):
```bash
dnf module reset nodejs -y
dnf module enable nodejs:20 -y
dnf install nodejs -y
node -v && npm -v
```

## 2 — Deploy as `admintsl`
```bash
su - admintsl
mkdir -p ~/ipo-portal && cd ~/ipo-portal
# upload the repo contents here (File Manager, scp, or git clone), then:
npm install --include=dev        # --include=dev: build needs tailwindcss
```

`better-sqlite3` is a native module — `npm install` normally pulls a **prebuilt** binary for
it, no compiler needed. If the install log shows it falling back to compiling from source
(look for `node-gyp rebuild`) and it fails, install a toolchain first (as root:
`dnf install -y gcc-c++ make python3`) and re-run `npm install`.

```bash
cp .env.example .env
chmod 600 .env                   # holds SESSION_SECRET, Veltrix keys, admin password
nano .env
```

Fill in `.env` before going live:
- `SESSION_SECRET` — long random string, not the placeholder
- `PORT` — pick one not already in use on this box (`ss -tlnp | grep node` to check), e.g. `3001`
- `BANK_NAME` / `BANK_ACCOUNT_NUMBER` / `BANK_ACCOUNT_NAME` — the real collection account
- `VELTRIX_BASE_URL`, `VELTRIX_VERIFY_CREDENTIAL`, `VELTRIX_API_KEY`,
  `VELTRIX_EMAIL_FROM*`, `VELTRIX_SMS_SENDER_ID` — from Trinity's Veltrix customer account
  (see the comments in `.env.example` — generate the verify **and** API-key credentials from
  the *same* Veltrix login so fees land on one wallet)
- `VERIFICATION_MODE`, `OTP_DELIVERY_MODE`, `NOTIFICATIONS_MODE` — **leave as `MOCK` until
  Veltrix credentials are confirmed working**, then flip to `LIVE`. Going live for real
  subscribers while these are still `MOCK` means BVN/NIN checks always "pass" and the OTP is
  handed back in the HTTP response instead of being sent — do not skip this.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — used once by the seed step below

```bash
npm run build:css
npm run seed                     # creates the admin user + one demo offer; prints the login
```
Log in at `/admin` after cutover and change that seed password immediately.

## 3 — PM2, loopback only (still as `admintsl`)
```bash
npm install -g pm2 --prefix ~/.local

~/.local/bin/pm2 start src/server.js --name ipo-portal --cwd ~/ipo-portal

~/.local/bin/pm2 save
curl -sI http://127.0.0.1:<PORT>/ | head -1     # expect: HTTP/1.1 200 OK
exit
```
`server.js` reads `PORT` from `.env` via `dotenv`, so no `-p`/`-H` flags are needed the way
`next start` needed them for prodigy-bank.

Back **as root**, boot persistence:
```bash
env PATH=$PATH:/usr/bin:/home/admintsl/.local/bin \
  pm2 startup systemd -u admintsl --hp /home/admintsl
# run the exact command it prints, then:
systemctl status pm2-admintsl --no-pager
```

## 4 — Apache reverse proxy (as root)
```bash
httpd -M 2>/dev/null | grep -E 'proxy_module|proxy_http_module|headers_module'
# install whichever are missing:
dnf install -y ea-apache24-mod_proxy ea-apache24-mod_proxy_http ea-apache24-mod_headers
```

Per-vhost include (survives cPanel vhost rebuilds — replace `<PORT>` with the value from `.env`):
```bash
mkdir -p /etc/apache2/conf.d/userdata/ssl/2_4/admintsl/ipo.trinitysecuritiesltd.com
cat > /etc/apache2/conf.d/userdata/ssl/2_4/admintsl/ipo.trinitysecuritiesltd.com/nodejs-proxy.conf << 'EOF'
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"
ProxyPass /.well-known !
ProxyPass / http://127.0.0.1:<PORT>/
ProxyPassReverse / http://127.0.0.1:<PORT>/
EOF

mkdir -p /etc/apache2/conf.d/userdata/std/2_4/admintsl/ipo.trinitysecuritiesltd.com
sed 's/"https"/"http"/' \
  /etc/apache2/conf.d/userdata/ssl/2_4/admintsl/ipo.trinitysecuritiesltd.com/nodejs-proxy.conf \
  > /etc/apache2/conf.d/userdata/std/2_4/admintsl/ipo.trinitysecuritiesltd.com/nodejs-proxy.conf

/scripts/rebuildhttpdconf
/scripts/restartsrv_httpd
```

> The `ssl/2_4` include only takes effect once an **SSL cert exists** for the domain (WHM →
> SSL/TLS → Manage AutoSSL, or wait for the scheduled run). Until then only the `std` (HTTP)
> proxy is active.

Check whether `www.ipo.trinitysecuritiesltd.com` (if used) is its own vhost:
```bash
httpd -S 2>/dev/null | grep ipo.trinitysecuritiesltd
```
If it shows as a **separate** vhost, duplicate both include dirs under the `www.` hostname
and rebuild + restart again.

## 5 — Verify
```bash
curl -sI https://ipo.trinitysecuritiesltd.com/ | head -3
curl -s https://ipo.trinitysecuritiesltd.com/admin | head -20   # should render the login page
```
Log in at `/admin`, confirm the demo offer loads on the home page, and change the seed admin
password.

---

## Ops afterward
```bash
su - admintsl -c '~/.local/bin/pm2 logs ipo-portal --lines 50'    # app logs
su - admintsl -c '~/.local/bin/pm2 restart ipo-portal'            # after pulling code changes
```
If a change touches Tailwind classes, rebuild CSS before restarting:
```bash
su - admintsl -c 'cd ~/ipo-portal && npm run build:css && ~/.local/bin/pm2 restart ipo-portal'
```

## Notes
- **Data protection:** the SQLite file (`dev.db` by default) holds BVN/NIN, which are
  sensitive under the NDPA 2023. It lives under `~/ipo-portal`, outside the web root, so it's
  never directly fetchable over HTTP — still worth `chmod 600`-ing it and including it in
  off-server backups.
- **No `.htaccess` needed** for this deploy the way prodigy-bank needed one, precisely because
  the app isn't under `public_html` — nothing to lock down at the Apache level.
- **Forms/notifications failing:** check `VELTRIX_*` env values and that `NOTIFICATIONS_MODE`/
  `OTP_DELIVERY_MODE`/`VERIFICATION_MODE` are actually set to `LIVE`, not left on `MOCK`.
- **`.env` drifts out of sync with `.env.example`:** the live `.env` was created once via
  `cp .env.example .env` at initial deploy and is never touched by `git pull` afterwards (it's
  gitignored, on purpose — it holds secrets). Any setting added to `.env.example` in a later
  commit (e.g. `EMAIL_DELIVERY_PROVIDER`/`SMTP_*` were added well after this site's first
  deploy) simply won't exist in the live `.env` at all — not blank, **absent**. A `sed` edit
  aimed at an existing `KEY=""` line will silently no-op if that key was never there to begin
  with. After pulling a change that touches `.env.example`, diff the two
  (`diff <(grep -oE '^[A-Z_]+' .env.example) <(grep -oE '^[A-Z_]+' .env)`) and append whatever's
  missing rather than assuming a `sed` replace did anything.
