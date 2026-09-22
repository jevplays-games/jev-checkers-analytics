# Technical references

The implementation follows the supplied Checkers/JEV plan and game specification. The following official documentation informed the integration boundary. Reviewed during package development on 2026-09-22; APIs, deployment tooling, and model availability should be rechecked before deployment.

- TypeSafe HTTP API and typed answers: https://docs.typesafe.ai/api
- TypeSafe versioned models and context limits: https://docs.typesafe.ai/models
- Discord OAuth2, scopes, token exchange and command-update authorization: https://docs.discord.com/developers/topics/oauth2
- Discord signed interactions and payload context: https://docs.discord.com/developers/interactions/receiving-and-responding
- Cloudflare Worker static assets: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare D1 prepared statements and transactional batches: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Node built-in SQLite: https://nodejs.org/api/sqlite.html

The automatic draw-adjudication variant, search weights/budgets, launch TTLs, quotas, ranking qualification, event schema, analytics scope, and failure policy are application design choices, not claims that the providers prescribe them. Source review is not the same as testing a live account or deployment.
