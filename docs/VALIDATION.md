# Release validation

Build date: 2026-09-22. This report distinguishes locally verified behavior, mocked integration contracts, and unexecuted live integrations.

## Executed checks

| Check | Result | Evidence |
|---|---|---|
| Node unit/integration suite | **87 passed, 0 failed, 0 skipped** | `reports/unit-tests.tap` |
| Instrumented Node coverage run | **87 passed** | `reports/test-coverage.txt` |
| Chromium source-loaded application checks | **13 passed** | `reports/browser-tests.json`, `reports/browser-check-run.txt` |
| Paired local-search vs seeded random | **8 completed games / 4 paired openings** | `reports/benchmark-search-v-random/` |
| Paired local-search vs one-ply heuristic | **8 completed games / 4 paired openings** | `reports/benchmark-search-v-heuristic/` |
| Browser-generated analytics ZIP | **11 entries, CRC validation successful** | `reports/browser-analytics-example.zip` |
| Exported replay CLI verification | **2 events reconstructed successfully** | `reports/example-replay.json`, `reports/replay-verification.json.txt` |
| JavaScript syntax | All shipped JS/MJS files accepted by `node --check` | Release check script execution |

Environment: Node v22.16.0, Python 3.13.5, Chromium 144.0.7559.96 on Debian/Linux. CPU/runtime details are retained in benchmark manifests.

The coverage run reports 97.63% lines, 88.48% branches, and 96.46% functions across the Node-instrumented file set. This includes test files and is **not** whole-product coverage: it excludes unexecuted browser/deployment code and says nothing by itself about live service correctness. Consult the per-file report, not only the aggregate.

## What the Node suite exercises

- Mandatory capture, all complete capture choices, short kings, promotion termination, returning king paths, illegal action rejection, exact starting moves, repetition/no-progress conditions, immutability, serialization, and seeded trajectory invariants.
- Deterministic strategy, bounded search, consistent root depth, candidate encoding, typed response validation, malformed answers, transient provider retry, provider errors, and forced-move accounting.
- Hash-chain/replay verification, tamper rejection, action-metadata consistency, analytics semantics, missing values, failure accounting, CSV safety, and ZIP structure.
- The actual Worker-compatible API against Node SQLite: ownership, CSRF, idempotency, revision conflicts, competing actions, lease expiry/stale response discard, authoritative turn flow, result finalization, no-contest handling, administrative abandonment, telemetry, and operator authorization.
- Real generated Ed25519 signatures over Discord-shaped interaction bodies; OAuth/session transitions with mocked network replies; one-use subject-bound grants; community match attribution; scope isolation; leaderboard/provisional calculations.

**External Discord and TypeSafe responses in these tests are deliberate fixtures.** Test names explicitly identify mocked provider contracts. These are not live model calls, real Discord sign-ins, or production D1 tests.

## Browser method and its limitations

The environment prohibited Chromium URL navigation. The supplied source-loaded harness (`scripts/browser-source-check.py`) therefore sets the actual HTML/CSS into an in-memory document and resolves the shipped ES modules as local Blob modules.

The application modules execute in Chromium: game rules, search, board rendering, charts, replay, analytics, and ZIP export. Storage, SHA-256, local HTTP transport, and Worker transport are harness bridges. HTTP requests use the actual running local Node API. Worker computation uses the actual strategy implementation but the harness does **not** verify real off-main-thread Worker transport, same-origin browser cookie behavior, CSP enforcement, or production browser networking.

The thirteen checks cover: 24 correctly sized initial pieces; a human/local-opponent turn pair; candidate comparison; independent replay; both actors in event audit; integrity verification; an actual 11-file ZIP; keyboard navigation; restoration from stored record; an empty real World leaderboard without fake entries; 390-pixel mobile layout; read-only import; and no uncaught game JavaScript errors.

The renderer was corrected during this validation to pass the piece array rather than the whole state object; piece sizing was also corrected. The included screenshots reflect the corrected source.

For the normal browser/real module Worker suite, install the optional JavaScript Playwright dependency and run `npm run test:e2e`. That suite is included but was **not run successfully through normal URL navigation in this build environment**. Prefer it for deployment qualification. The restricted source harness requires Python Playwright plus a Chromium executable (`CHROMIUM_PATH`, default `/usr/bin/chromium`) and a running `npm start` server on port 8787.

## Benchmark interpretation

Both included smoke runs use Easy local tactical search, not JEV. All sixteen games completed; no move-cap result was converted into a draw. The local-search agent won these small fixture suites. That is a regression/sanity observation, not a calibrated strength rating or evidence of JEV improvement.

Only four independent starting-position clusters occur per opponent. A degenerate bootstrap interval when every sampled cluster has the same result must not be read as certainty about unseen positions. Increase fixture diversity and sample count before interpreting performance; keep tuning and evaluation suites separate.

The harness supports real JEV treatment, JEV opposition, and a same-budget search-only ablation with explicit remote opt-in. Those remote experiments were not executed. Operational exports retain attempted requests and failures in addition to accepted decision evidence.

## Not verified in this release build

- A live TypeSafe request using a real API key; actual model availability, quality, provider latency, or billing.
- A live Discord account login, real guild installation, or live signed command delivery.
- Cloudflare deployment, Wrangler build/dry run, production D1 behavior, Worker CPU limits, or scheduled recovery on that platform.
- Real browser cookie/CSP/module-Worker networking through normal navigation in this environment.
- A third-party security audit, accessibility conformance certification, adversarial multi-account testing, or internet-scale load test.

No credentials, active accounts, or deployments are bundled. Complete the staging checklist in `SECURITY.md` before enabling public ranked play.
