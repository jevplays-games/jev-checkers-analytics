# Analytics: scope, dictionary, provenance, and exports

The application separates **authoritative game events**, **server operations**, **provider-reported values**, and **optional untrusted browser telemetry**. “Complete” means all events in the selected record/time range, not unlimited retention or observation of things the application cannot measure. Model calls are not made just to fill analytics fields.

## Data layers

| Layer | Contents | Trust and visibility |
|---|---|---|
| Match manifest | Rules/engine/profile/model versions, starting state, assigned color, mode, frozen context | Server-created for authoritative matches; client-created for practice/imports |
| Event stream | Accepted move or administrative event, actor, UTC time, turn duration, state hashes, previous-event hash, structured evidence | Only server events can support an official result |
| Provider operations | Request packet, candidate/search evidence, question text, attempts, validated answers, usage, failures, stale-work records | Owner-only API and operator API; no credentials or Discord names in model packets |
| Derived analysis | Every position and turn, counts, distributions, candidate tables, heatmaps | Recomputed from a replay; not a replacement for authenticating its origin |
| Optional browser telemetry | Coarse render/ack/retry/visibility/error durations | Explicit opt-in; marked `untrusted_client`; never scoring input |

The browser and CLI share `public/lib/analytics.js`. `analyzeReplay()` is a derivation function, not an authentication function. Imports and the CLI verifier validate structure/integrity first. The server validates its own authoritative stream before official eligibility.

## Match and piece statistics

`turns` counts move events, excluding resignations, failures, and administrative events. `sourceCounts` distinguishes human, JEV, forced, and local decisions. A forced move does not consume a model call.

For each color: moves, pieces captured, capture turns, multi-jump turns, promotions, king moves, and maximum captured pieces in one turn. `captures` counts pieces, not turns. A promotion is recorded only when the engine promotes the moved man. A king move means the piece was already a king at the start of that turn.

`byPhase` assigns each move to the phase of its **pre-move** position. Phase thresholds are versioned in `strategy.js`: more than 18 pieces is opening, 9–18 is middlegame, and 8 or fewer is endgame. A snapshot contains piece counts, material, advancement, legal mobility, center occupancy, support, edge/back-rank occupation, near-promotion count, and capture availability for both sides.

Material values are man=100 and king=175 heuristic units. Material balance and heuristic balance are separate. Neither is a probability or a tournament rating. Mobility is the legal-action count according to the implemented capture rules; a jump chain is one action.

## Timing

Every distribution returns finite-value `count`, `sum`, `min`, `max`, `mean`, `p50`, `p90`, `p95`, and `p99`. Quantiles linearly interpolate between sorted samples at index `(n−1)×p`. Missing values are excluded; an empty set has null extrema/mean/quantiles and a sum of zero.

| Metric | Unit and sample population | Interpretation |
|---|---|---|
| `timing.opponent` | Milliseconds, committed opponent decisions plus recorded terminal service failures | Total adapter elapsed time; includes work beyond search/provider timing |
| `timing.provider` | Milliseconds per recorded adapter decision/failure | Provider/retry loop elapsed time, including retry delay and associated operation work |
| `timing.search` | Milliseconds per committed opponent search | Search duration only |
| `timing.humanElapsed` | Milliseconds per submitted human move | Wall elapsed time since previous server/local turn transition; may include absence, network time, background tabs |
| Attempt `latencyMs` | Milliseconds per provider attempt | Stored in decision evidence and operations, including failures |

Local browser search and server search run in different runtimes. Do not mix their latency distributions as a provider speed benchmark. Monotonic `performance.now()` is used within work; UTC timestamps correlate events across processes but are not claimed to be synchronized to submillisecond accuracy.

## Search and candidate analytics

Record full legal count, actual evaluated shortlist, pruned count, node count, last fully completed uniform root depth, search time, node-budget exhaustion, deterministic baseline action, chosen action, and candidate ordering.

`candidateCoverage = evaluatedCount / legalCount` for each opponent move with a positive legal count. It measures shortlist coverage, not proof coverage. `totalPruned` adds the recorded candidate-pruning counts. Node count includes work spent in an interrupted iteration; reported completed depth does not.

Candidate rows include event/ply, rank, chosen status, action path ID, tactical score, JEV adjustment, final utility, promotion/mobility/support scores and trap assessment. Unused factors remain null. Frontiers and exact board features remain available in detailed decision/provider evidence rather than being flattened away.

`changedFromBaseline` counts decisions where the model-adjusted selected action differs from the search-only baseline. The rate divides by committed JEV decisions, not forced/local moves. It measures influence, not benefit.

`searchRegret = max(0, best shortlisted tactical score − selected tactical score)`. This is **heuristic disagreement in the implemented search units**, not regret against perfect play, and not a probability. It uses the same decision's candidate pool.

## Model answers and usage

Score factors use a five-level rubric; expected scores can be fractional. For each returned Score distribution, record confidence and Shannon entropy in bits: `−Σ p log2(p)` over positive probabilities. Noul is a scalar on [0,1] with no separate confidence. Confidence/entropy distributions include every relevant factor/candidate answer, not just selected candidates.

`jev.calls` counts recorded attempts, including failed attempts and attempts in a terminal service-failure event. `retries` sums attempts beyond the first per recorded decision. `failedAttempts` counts non-OK attempts; `serviceFailures` counts terminal match-level service failures. A retry that later succeeds is still counted as a failed attempt.

`inputTokens`/`outputTokens` sum usage **only where returned and validated**. `usageKnownCalls` and `unknownUsageCalls` distinguish known from missing. A failed or malformed response can incur provider charges even when its usage is unavailable. Zero known tokens does not mean a free request. `costUSD` stays null; pricing is not guessed, and analytics are not an invoice.

**Scope caveat:** accepted event summaries include the evidence attached to committed decisions or service failures. Orphaned, crashed, and subsequently discarded attempts can exist only in the operational stream. Use `operations.ndjson` or `/api/analytics/admin` for operational totals rather than expecting game-event totals to equal all provider work.

## Heatmaps and timelines

Position snapshots include the initial position plus every committed move. Occupancy heatmaps count snapshot presence, not elapsed dwell time. Landing heatmaps count **final landing squares** of complete moves; intermediate jump landings are visible in action paths but are not counted as additional turns. Capture heatmaps increment every captured square. The live UI displays landing heat; the export contains all three families.

The replay scrubber reconstructs a separate board without changing the live match. An imported replay is read-only. Its claimed trust field or outcome does not confer official status.

## Analytics ZIP

| File | Content |
|---|---|
| `manifest.json` | Frozen game/profile/provenance manifest |
| `replay.json` | Manifest, ordered events, recomputed-compatible final state and claimed outcome |
| `summary.json` | Full derived metrics, distributions, timelines, moves, candidates |
| `moves.csv` | One row per move |
| `candidates.csv` | One row per evaluated candidate for each recorded opponent move |
| `positions.csv` | Initial plus every post-move snapshot |
| `events.csv` | Flat event envelopes and structured evidence columns |
| `events.ndjson` | Exact event records, one JSON object per line |
| `operations.ndjson` | All available owner-fetched operation pages; empty for local or standalone imported records |
| `heatmaps.json` | Occupancy, final landings, captures, snapshot count |
| `README.txt` | Trust/export warning |

CSV is UTF-8, quoted, CRLF-delimited, and neutralizes leading formula characters in strings. Numeric negative values remain numeric strings rather than formula payloads. Structured columns are JSON-encoded. Browser ZIP generation uses a small native uncompressed ZIP writer with CRC-32; no external export library, network upload, or tracking service is used.

An export contains game positions and model packets. Treat it as research/game data you choose to disclose. Private community IDs may exist in an owner's manifest. Public World leaderboard responses do not reveal originating private communities.

## Account, community, and operator summaries

`/api/analytics/me` covers all owned server matches grouped by cohort/difficulty/opponent/mode and a latest-100 history list. Local history is a separate browser convenience list capped at five records. These are not merged into official statistics.

Leaderboards use verified ranked outcomes, scoped community provenance, the frozen profile cohort, both colors, and qualification of ten games per color. Win=2, draw=1, loss=0 units. Balanced score is `25×(redUnits/redGames + whiteUnits/whiteGames)`. Scores are compared with exact integer ratios, not rounded display values. Provisional entries are visible without a competitive rank. Draws/losses end winning streaks.

The operator endpoint accepts a private Bearer token and a 1–90-day range. It reads all matching database rows for operation kind/trust counts, outcome groups, provider attempts, timing, and known/unknown usage. It does not sample. It is intended for a small deployment: large archives will require SQL rollups or a warehouse before this approach scales economically.

Optional HTTP logging writes sanitized request ID/status/method/duration to the hosting console when enabled. It is not a persistent request-level dashboard or guaranteed complete network log. HTTP route/query/body/IP/cookie content is omitted.

## Retention and privacy

No third-party analytics script, session recording, keystrokes, chat text, or browser IP capture is implemented. Hosting/CDN/provider infrastructure can have its own logs outside this application's control.

Optional browser-telemetry rows are deleted after seven days by maintenance. Sessions expire after seven days; short grants expire after ten minutes, with expired grant rows later cleaned up. Community read proof lasts at most fifteen minutes from the signed interaction. Expired quotas are cleaned up.

Authoritative matches, game events, and server/provider operations are retained until an operator applies an explicit retention policy. They are **not automatically deleted in this release**. Backups, account erasure workflow, and data-access policy require operator decisions before public launch. Do not delete active-game provider evidence needed for final verification. Keep exports for records that must outlive deployment retention.

The application does not claim exhaustive measurement of human thought, model hidden reasoning, actual invoice charges, external assistance, or continuous Discord permission state.
