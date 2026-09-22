# Security and privacy boundaries

## What is trusted

The browser is untrusted. DOM state, imported replays, local storage, telemetry, and editable URL parameters cannot create official scores. The server owns authoritative states, opponent decisions, identities, context grants, frozen profiles, accepted events, and finalization.

The rules engine is deterministic but not an authentication mechanism. A user can recreate a valid hash chain outside this service. Official status additionally depends on the server's ownership and provider provenance. The UI/CLI explicitly distinguish integrity verification from authenticated official status.

## Implemented defenses

- Opaque random session tokens stored hashed; HttpOnly/SameSite cookies, production Secure prefix, expiry, rotation after login, explicit logout.
- Exact configured Origin checks plus session CSRF token on browser writes. Discord's raw-body signature verification on its own endpoint.
- One-use OAuth state bound to the initiating browser session; allowlisted local return paths; server-only code exchange; discard/revoke OAuth tokens after identity lookup.
- Timestamp-bounded Discord Ed25519 signatures; guild/application/installation checks; hashed ten-minute subject-bound launch token; unsupported DMs/threads rejected.
- User-bound match ownership, server-generated opponent turns, legal-action validation, immutable profile configuration, revision/lease checks, idempotent event commits.
- Replay integrity and complete state reconstruction, plus accepted JEV response provenance for ranked finalization. Browser-provided scores are never accepted.
- Content-security policy, self-hosted native modules/CSS, names rendered as text, bounded JSON bodies, no sensitive headers/query parameters in application logs, formula-safe CSV strings.
- API keys/Discord secrets only in server environment. Operator analytics requires a separate private token. Provider packets contain game data, not account or community identities.
- Usage quotas, bounded candidate/question sizes, an eight-second provider budget, at most two attempts, one active ranked game, and no local fallback counted as JEV.

## Explicit limitations

A secure application session does not prove unaided human play. External engines, account sharing, and multiple Discord accounts are not prevented. Guest sessions can be reset; the global match-start cap and deployment controls limit aggregate exposure, but are not a monetary invoice cap.

Community context proves that the authenticated user invoked an installed application in a channel at a specific time. It is not continuous membership verification. The read proof can remain valid for up to fifteen minutes after a permission change. Match attribution remains frozen at its start.

A database/server compromise can alter stored records and hashes. There is no external timestamp service or separately anchored audit signature. Backups and restricted database access are operational requirements.

Leases prevent duplicate committed turns, not necessarily duplicate external requests after a crash. Failed calls may be billable with unknown usage. Monitor provider-side limits.

Trustworthy finite search is not perfect checkers. Search heuristics, model confidence, and benchmark score estimates are not proofs of optimal moves or calibrated human ratings.

This release retains authoritative data until an operator applies a policy. It does not include self-service account deletion, consent-law assessment, multi-region disaster recovery, or automatic migration of historical engine implementations. Resolve those before public launch according to your requirements.

## Before public deployment

1. Set the exact HTTPS origin, genuine credentials, D1 binding, registered Discord redirects/interaction endpoint, and least-privilege application install settings. Never publish local databases or `.env`/`.dev.vars`.
2. Run unit tests, standard browser tests with real module Workers, staging provider failures, a real OAuth login, a signed real guild launch, a full ranked game, and a reconnect/recovery cycle.
3. Measure Worker CPU/memory against every enabled search profile. Changing search budgets requires a new profile hash/cohort rather than an invisible downgrade.
4. Set provider spending limits, match quotas, edge traffic protection, monitoring, backup/restore procedures, an operator retention policy, and contact/deletion procedures.
5. Restrict the operator token and database access. Review exports before sharing: an owner's manifest can include private community context even though the public World view does not.

Do not call the release production-certified, cheat-proof, or externally audited on the basis of the included tests.
