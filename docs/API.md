# HTTP API

Base origin is configured by `APP_ORIGIN`. JSON requests use `Content-Type: application/json`. Browser mutations require both the correct `Origin` and `X-CSRF-Token` from `GET /api/me`, plus the HttpOnly session cookie. Signatures replace browser CSRF for Discord interaction delivery. External secrets and score declarations are never accepted from browser game requests.

## Endpoints

| Method and path | Access | Result |
|---|---|---|
| GET `/api/health` | Public | Service identifier/version; not an external-provider health probe |
| GET `/api/me` | Creates/resumes session | Identity, CSRF token, capabilities, active match, short context |
| GET `/api/auth/discord` | Browser session | One-use OAuth authorization redirect |
| GET `/api/auth/discord/callback` | Matching state/session | Identity lookup and rotated application cookie |
| POST `/api/logout` | Session+CSRF | Revoke current session |
| POST `/api/discord/interactions` | Valid Discord Ed25519 signature | Signed PING handling or guild launch link |
| POST `/api/launch/redeem` | Discord identity+CSRF | Consume subject-bound launch token |
| POST `/api/matches` | Session+CSRF | Create frozen authoritative match |
| GET `/api/matches/:id` | Owner | Snapshot, legal actions, revision, state, latest evidence |
| POST `/api/matches/:id/actions` | Owner+CSRF | Validate/commit human move or resignation |
| POST `/api/matches/:id/advance` | Owner+CSRF | Request pending work/recovery; cannot select model inputs |
| GET `/api/matches/:id/replay` | Owner | Manifest and ordered hash-linked events |
| GET `/api/matches/:id/analytics` | Owner | Complete derived replay analysis |
| GET `/api/matches/:id/operations` | Owner | Paged detailed server/provider/untrusted-client operations |
| GET `/api/leaderboard` | Public World; fresh identity/context for communities | Current or requested cohort with stable-cutoff pagination |
| GET `/api/analytics/me` | Session | Owned cohort totals and latest 100 server matches |
| GET `/api/analytics/admin` | Private operator Bearer token | 1–90-day operational/outcome/provider summaries |
| POST `/api/telemetry` | Owner+CSRF+explicit consent | Bounded allowlisted untrusted client observations |

## Match creation

```json
{
  "gameId": "checkers",
  "mode": "casual",
  "opponent": "jev",
  "difficulty": "normal",
  "requestId": "a-client-generated-unique-id"
}
```

`mode`: casual/ranked. `opponent`: jev/local. Ranked requires Discord, configured JEV, and no other active ranked match. Local practice normally runs entirely in the browser; server-local matches exist for testing and unofficial server play. Any community attribution comes from a redeemed server-held entitlement, never creation-body IDs.

Difficulty: easy/normal/hard/jev. A request key reused with different content is a conflict. Exact body validation and limits are enforced in `server/matches.js`.

## Human action

```json
{
  "expectedRevision": 12,
  "requestId": "another-unique-id",
  "actionId": "j:09x18x27"
}
```

The action ID denotes an entire legal turn. Quiet moves use `m:09-13`. Intermediate clicks are not submitted game moves. Resignation uses the same envelope with `resign: true` instead of `actionId`. The server creates captured-square and promotion metadata itself.

A successful response is an authoritative snapshot, possibly with `status: "jev_pending"`. Poll GET or call `/advance` to request pending work. Never assume receiving an HTTP response means the opponent has finished.

## Analytics and operations

`GET /analytics?format=moves.csv`, `candidates.csv`, or `events.csv` returns UTF-8 CSV. Default `format=json` returns the full object, including position and candidate data.

Operations pages contain at most 500 entries. Follow the returned cursor exactly:

```json
{
  "entries": [],
  "next": {"after": 1790030000000, "afterId": "last-returned-operation-id"}
}
```

Supply both `after` and `afterId` on the next request. A null `next` ends pagination. Owner exports fetch every page. A subsequent newly arriving operation can naturally fall outside an export already being assembled; the ZIP is a snapshot, not a continuously updating stream.

The operator endpoint uses `Authorization: Bearer <ANALYTICS_ADMIN_TOKEN>` and `?days=7` by default. Keep that token out of browser code and dashboards. This version exposes JSON rather than an internet-accessible admin UI.

## Leaderboards

Query `scope=world|server|channel`, `difficulty=normal`, optional 64-character `cohort`, and returned `cursor`. Community selectors refer only to the caller's current verified context. Supplying a different browser ID cannot choose a community.

Responses contain `asOf`, cohort, qualification rule, total, entries, and next cursor. Page size is 50. Provisional records have `rank: null`. An `asOf` cutoff stabilizes result inclusion while paging; identity changes or moderation during paging are not immutable historical snapshots.

## Errors and limits

Responses contain a safe error message, code, and request ID. 400: invalid request; 401: no session/signature; 403: ownership/context/CSRF; 409: stale revision or conflicting idempotency; 422: illegal action; 429: quota; 503: unavailable configuration/provider. Unexpected failures return a generic 500, not a stack trace or secret.

Provider input is generated only from authoritative matches. There is no generic prompt/model proxy and no client score-submission endpoint. Body/telemetry/provider response limits, per-session advancement limits, and match-start quotas bound abuse. Deployment should add edge-level traffic controls to protect endpoints that must remain public.
