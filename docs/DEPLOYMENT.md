# Deployment

## GoDaddy Node hosting

The same `server/worker.js` handler runs as a plain Node app through `scripts/dev-server.mjs` (`npm start`).

- Platform runs `npm run build` (a no-op) and then `npm start`; it injects `PORT`. Production mode is on when `NODE_ENV=production` or `APP_ORIGIN` is https on a non-loopback host (GoDaddy's runtime may not set `NODE_ENV`; loopback or http origins stay local dev). In production the server binds `0.0.0.0` (override with `HOST`) and runs with `APP_ENV=production`, so ranked play, Discord auth and the Activity behave as on Cloudflare.
- Zip layout: repo root files (`package.json`, `server/`, `public/`, `scripts/`, `migrations/`) plus a root `.env`. No `npm install` is needed (zero runtime dependencies). Requires Node 22.16+.
- Required env: `NODE_ENV=production`, `APP_ORIGIN=https://typecheckers.jevplay.games` (the request URL is built from it, so CSRF/origin checks and `__Host-` Secure cookies use it regardless of the proxy Host header), `TYPESAFE_API_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, `ANALYTICS_ADMIN_TOKEN`. Optional: `HOST`, `DB_PATH`, `GLOBAL_DAILY_MATCH_LIMIT`, `LOG_REQUESTS`, `BUILD_ID`, `TRUST_PROXY=1` (take the client IP from `X-Forwarded-For` for rate limits).
- Database: SQLite file at `.data/typecheckers.sqlite` (or `DB_PATH`; an existing pre-rename `.data/checkers.sqlite` is used while no new file exists), created on start, never inside `public/`. **It lives on ephemeral storage: matches, sessions and leaderboards are lost on redeploy.**
- The Cloudflare cron (`*/5`) is replaced by the in-process 60-second maintenance timer.
- **The old hostname is not served as a second origin on Node.** Because every request URL is built from `APP_ORIGIN`, `LEGACY_APP_ORIGINS` has no effect here: pages on `checkers.jevplay.games` would load, but every sign-in write or game move from that host gets 403 ("Origin mismatch"). Leave `LEGACY_APP_ORIGINS` unset on Node and send the old host to the new one with a 301 at the proxy or DNS level. Serving both hosts is Worker-only (below).

## Checkers → Typecheckers rename (hostnames, Worker, D1)

The game was renamed from Checkers to Typecheckers. `typecheckers.jevplay.games` is canonical; `checkers.jevplay.games` keeps working until the redirect cutover.

- **One Worker, two hosts.** `wrangler.jsonc` attaches both custom domains. `APP_ORIGIN` is the new origin and `LEGACY_APP_ORIGINS` (comma-separated) lists the old one. Each entry must be a bare origin, scheme and host only, such as `https://checkers.jevplay.games` (one trailing slash is tolerated). An entry with credentials, a path, a query, a fragment or a `*` is skipped and logged once as a `legacy_origin_skipped` warning; it never causes an error, and the old host then simply loses its legacy handling. In production only `https:` entries are accepted. A request on a listed origin keeps its own origin for launch links, the OAuth `redirect_uri` and the CSRF origin check, so a signed-in player on the old host stays signed in there. A mutation whose `Origin` names a different host than the one it was sent to is refused. This is Worker-only: the Node server builds every request URL from `APP_ORIGIN`, so on Node hosting writes from the old host get 403 and the old host must be a redirect, not a second origin (see GoDaddy Node hosting above). Both callbacks (`https://typecheckers.jevplay.games/api/auth/discord/callback` and the old one) must be registered as OAuth redirects in the Discord Developer Portal.
- **Worker name.** The Worker is now `jev-typecheckers` (was `jev-checkers`). Cloudflare treats a new `name` as a new Worker: the first `wrangler deploy` creates `jev-typecheckers`, and the `checkers.jevplay.games` custom domain has to move to it from `jev-checkers`. After that, delete the old `jev-checkers` Worker so its `*/5` cron does not run maintenance against the same D1 database twice. This was not tried against Cloudflare.
- **D1.** The database keeps its name `checkers` and its id (owner decision 2026-10-14). Nothing is recreated or migrated. Existing rows keep `gameId:"checkers"` in `manifest_json`; leaderboards do not filter on `gameId`, so standings carry over. The npm `db:*` scripts still name `checkers`.
- **Cutover.** When the owner approves, add a 301 from `checkers.jevplay.games/*` to `https://typecheckers.jevplay.games/*` that keeps the path and query (a Cloudflare redirect rule, or keep the old custom domain on this Worker and redirect there), then drop `LEGACY_APP_ORIGINS`. Sessions are host-scoped `__Host-` cookies, so players signed in on the old host sign in again on the new one. Browser storage is per-origin: a practice match or local history saved on the old host does not follow the redirect.

## Continuous deployment to GoDaddy

`.github/workflows/deploy.yml` runs `npm test` on every pull request and push. On a push to `main` (or **Run workflow**) it then zips the committed tree with `git archive` and `scripts/godaddy-deploy.js` uploads it through the GoDaddy Hosting API (`https://api.godaddy.com/v1/hosting`), waits for the import, and deploys it to the published app `NODEJS-spaazpgra4`. A failed test, import or build stops the run and leaves the live app unchanged.

- Repository secret `GODADDY_PAT`: a GoDaddy Personal Access Token with `hosting.application:read`, `hosting.source:write` and `hosting.deployment:execute`. Without it the deploy step is skipped with a warning.
- Optional repository variable `GODADDY_APP_ID` overrides the target app (API IDs carry the `NODEJS-` prefix).
- Runtime configuration is not in the zip: keep it under the app's **Settings → Secrets** (Preview and Publish) in GoDaddy.
- Manual deploy: put `GODADDY_APP_ID` and `GODADDY_PAT` in `.env`, then `git archive --format=zip -o deploy.zip HEAD && npm run deploy:godaddy -- deploy.zip`.
