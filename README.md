<p align="center"><img src="assets/banner.jpg" alt="Pixel-art robot Jev playing checkers with cyan and magenta pieces beside a glowing bar-chart hologram in a neon arcade" width="100%"></p>

# JEV Arcade — Checkers + Analytics

A playable, single-page American-checkers application with inspectable JEV decisions, a deterministic rules engine, authoritative server matches, Discord identity/community launch, verified leaderboards, and extensive first-party analytics.

**Local practice works immediately.** A real TypeSafe API key is required for JEV play. Discord credentials and installation are required for identity and community features. The package contains these integrations; it does not contain credentials, a deployed service, or fabricated JEV benchmark results.

## Run locally

Install **Node.js 22.16 or later**. Extract the archive, then:

```sh
cd jev-checkers-analytics
npm start
```

Open `http://127.0.0.1:8787`. No `npm install` is required for local play, the API, unit tests, or the command-line analytics tools. SQLite is provided by Node; Node 22 may print its experimental SQLite warning.

The development server listens on loopback, creates `.data/checkers.sqlite`, and runs the same API implementation used by the Worker deployment. It is a development runner, not a hardened internet-facing Node server.

The default opponent is labeled **Local search — practice**. Local practice is not JEV and cannot enter official leaderboards. Select a piece and destination, or use the accessible legal-move list. Captures may require several successive destinations before a complete turn is submitted.

## Features

- American/English checkers: mandatory captures, complete branching multi-jumps, short kings, forward-only men, crown-row termination, blocked-player defeat, deterministic web draw adjudication.
- Easy, Normal, Hard, and JEV profiles: deterministic search budgets and structured positional questions rather than random mistakes.
- Real server-only JEV integration with typed Score/Noul answers, validation, bounded retries, frozen profiles, and explicitly labeled forced decisions.
- Live board, keyboard navigation, mobile layout, reduced-motion support, rules panel, decision evidence, complete candidate comparison, replay scrubber, and import/export.
- Material and mobility timelines, latency distributions, search accounting, piece statistics, phase counts, heatmaps, model-answer entropy, token accounting, failures/retries, and full event records.
- One-click **11-file analytics ZIP**, plus CSV/JSON/NDJSON exports and offline CLI reconstruction.
- Discord `identify` OAuth, signed guild slash-command launch, account-bound single-use context, Channel/Server/World leaderboards, and owner-scoped history.
- Server-authoritative turns, revision checks, leases, idempotency, SHA-256-linked records, replay/provenance verification, quotas, and no-contest handling.
- Headless paired-color benchmarks, including an explicit same-search-budget JEV ablation mode.

## Configure real JEV

Copy `.env.example` to `.env` and set:

```dotenv
TYPESAFE_API_KEY=your_private_key
```

Restart the server. The JEV option becomes available. The frozen profiles request `jev-1.13.0`; model output is not assumed to be repeatable, so accepted responses are recorded for deterministic decision reconstruction.

No API key is sent to the browser. Missing credentials do not activate a simulated JEV. A provider failure ends a remote match as a no-contest and offers a clearly labeled local continuation, never an official substituted result.

## Configure Discord

In the Discord developer application:

1. Add the OAuth redirect `http://127.0.0.1:8787/api/auth/discord/callback` for local identity testing, where supported by Discord, or your deployed HTTPS equivalent.
2. Set `DISCORD_APPLICATION_ID` and `DISCORD_CLIENT_SECRET` in the server environment. Identity requests only the `identify` scope.
3. For community launch, also set `DISCORD_PUBLIC_KEY`, deploy a public HTTPS endpoint, and register that origin's `/api/discord/interactions` as the interaction endpoint.
4. Run `npm run discord:register` with the application credentials. This upserts `/play checkers`; it does not bulk-delete other commands.
5. Enable guild installation and install with `applications.commands`. The implementation uses signed HTTP interactions, not a persistent bot connection.

The interaction is restricted to ordinary guild text channels. It produces a private, ten-minute, account-bound launch link. A fresh interaction establishes short-lived community access; it does not continuously monitor channel membership.

Set `APP_ORIGIN` to the exact origin used in the browser. It is used for redirects, same-origin checks, cookies, and launch links. Do not interchange `localhost` and `127.0.0.1` during a session.

## Analytics and exports

The match observatory contains Overview, Decisions, Replay, Event audit, Leaderboards, and My history. All recorded turns are used; per-match analytics do not sample moves.

Click **Export analytics ZIP** for `replay.json`, `summary.json`, `manifest.json`, move/candidate/position/event CSVs, event/operation NDJSON, heatmaps, and a provenance note. For server matches, the exporter fetches all owned operational pages before producing the archive. Imported/local records cannot independently retrieve server operational records.

```sh
npm run verify -- reports/example-replay.json
node scripts/analyze-replay.mjs reports/example-replay.json ./analysis-output
```

See [the metric dictionary](docs/ANALYTICS.md). Important distinctions: human elapsed time is not active attention; model confidence is not win probability; heuristic regret is not a solved value; missing usage is unknown, not zero billed usage. Dollar cost is deliberately unestimated.

## Test and benchmark

```sh
npm test
npm run bench -- --pairs 4 --profile easy --opponent random --out bench/results/random
npm run bench -- --pairs 4 --profile easy --opponent heuristic --out bench/results/heuristic
```

A real JEV experiment requires an explicit billable opt-in:

```sh
npm run bench -- --pairs 4 --profile normal --opponent heuristic --ablation --allow-remote --out bench/results/jev-ablation
```

`--ablation` compares JEV+search with identical-budget search-only against the same opponent, on matching positions and both colors. No provider access means no remote experiment. Move-cap games are reported as truncated, not draws.

Optional browser/deployment tools are not runtime dependencies:

```sh
npm install --save-dev @playwright/test wrangler
npx playwright install chromium
npm run test:e2e
```

The standard Playwright suite uses a real browser server and module Worker. This suite is supplied for normal environments. The included build reports distinguish it from the source-loaded Chromium checks performed in this restricted build environment.

## Deploy to Cloudflare

After installing Wrangler as above:

```sh
npx wrangler login
npx wrangler d1 create checkers
```

Put the returned database ID in `wrangler.jsonc`, replace the host placeholder with your intended HTTPS origin, and set the Discord application ID/public key as configuration. Keep secrets out of the configuration file:

```sh
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put ANALYTICS_ADMIN_TOKEN
npm run db:remote
npm run deploy
```

Set the origin and register the Discord redirect/interaction URLs consistently. For `wrangler dev`, use a git-ignored `.dev.vars` file for private local bindings. Do not publish `.env`, `.dev.vars`, local databases, or operator tokens.

The deployment includes static assets, one Worker, one D1 database, and a five-minute recovery/cleanup schedule. Verify search CPU cost against the configured Worker plan before enabling larger profiles. D1 batch semantics and live external integration require staging validation; see [VALIDATION.md](docs/VALIDATION.md).

Initial safety limits are five guest remote match starts per day, thirty authenticated starts per day, and a global limit of 200 (configurable). These are coarse safeguards, not a dollar-budget guarantee. Add provider-side spending controls before public exposure.

## Reports included

`reports/` contains the test transcript, browser check report, desktop/mobile previews, an actual browser-generated export/replay, and two search-only paired benchmark runs. No live JEV result is represented as measured here.

## Documentation

- [Architecture and diagrams](docs/ARCHITECTURE.md)
- [Analytics semantics and retention](docs/ANALYTICS.md)
- [API and export endpoints](docs/API.md)
- [Trust, privacy, and deployment checklist](docs/SECURITY.md)
- [Validation evidence and known limits](docs/VALIDATION.md)
- [External technical references](docs/SOURCES.md)

Additional games can reuse the identity, context, session, audit, provider, and leaderboard boundaries. Checkers-specific rules and strategy stay under `public/games/checkers/`.

## Release limitations

This is a source release, not a deployment or security certification. A valid hash chain alone does not authenticate a downloaded replay. Official status is established only by the server's recorded provenance. Outside engine assistance, multiple Discord accounts, and continuous membership monitoring are not solved. Local-storage failure can lose an unfinished practice game; export records you need to retain.

No software license is selected by this package. Choose an appropriate license before publishing or redistributing the project.
