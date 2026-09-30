# Deployment

## GoDaddy Node hosting

The same `server/worker.js` handler runs as a plain Node app through `scripts/dev-server.mjs` (`npm start`).

- Platform runs `npm run build` (a no-op) and then `npm start`; it injects `PORT`. Production mode is on when `NODE_ENV=production` or `APP_ORIGIN` is https on a non-loopback host (GoDaddy's runtime may not set `NODE_ENV`; loopback or http origins stay local dev). In production the server binds `0.0.0.0` (override with `HOST`) and runs with `APP_ENV=production`, so ranked play, Discord auth and the Activity behave as on Cloudflare.
- Zip layout: repo root files (`package.json`, `server/`, `public/`, `scripts/`, `migrations/`) plus a root `.env`. No `npm install` is needed (zero runtime dependencies). Requires Node 22.16+.
- Required env: `NODE_ENV=production`, `APP_ORIGIN=https://checkers.jevplay.games` (the request URL is built from it, so CSRF/origin checks and `__Host-` Secure cookies use it regardless of the proxy Host header), `TYPESAFE_API_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, `ANALYTICS_ADMIN_TOKEN`. Optional: `HOST`, `DB_PATH`, `GLOBAL_DAILY_MATCH_LIMIT`, `LOG_REQUESTS`, `BUILD_ID`, `TRUST_PROXY=1` (take the client IP from `X-Forwarded-For` for rate limits).
- Database: SQLite file at `.data/checkers.sqlite` (or `DB_PATH`), created on start, never inside `public/`. **It lives on ephemeral storage: matches, sessions and leaderboards are lost on redeploy.**
- The Cloudflare cron (`*/5`) is replaced by the in-process 60-second maintenance timer.
