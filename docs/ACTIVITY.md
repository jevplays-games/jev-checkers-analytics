# Discord Activity mode

Discord can launch the game as an Activity: an iframe on `https://<APPLICATION_ID>.discordsays.com`, proxied to this Worker. The normal browser flow is unchanged; Activity behavior applies only when the document URL carries Discord's `frame_id` query parameter.

## What changes inside an Activity

- **Sign-in.** `public/activity.js` uses the vendored Embedded App SDK (`public/vendor/discord-embedded-app-sdk.js`, loaded same-origin because the CSP is `script-src 'self'`). The SDK's authorization code (scope `identify`) is posted to `POST /api/activity/session`, which exchanges it *without* `redirect_uri` using the existing `DISCORD_APPLICATION_ID` / `DISCORD_CLIENT_SECRET`, upserts the user exactly as the OAuth callback does, and creates a 24-hour session. It returns a bearer token, a CSRF token and the Discord access token (for `sdk.commands.authenticate`, never stored).
- **Bearer sessions.** Browsers do not send the SameSite cookie in the iframe, so the client keeps the token in memory and sends `Authorization: Bearer <token>`. Only the SHA-256 of the token is stored, in the same `sessions` table.
- **Origin.** Mutations normally require `Origin` to equal `APP_ORIGIN`. A request authenticated by a bearer token may alternatively come from `https://<DISCORD_APPLICATION_ID>.discordsays.com`. Cookie sessions never get this allowance, and the CSRF token is always required.
- **Framing.** Responses stay `frame-ancestors 'none'`, except non-API documents requested with `frame_id`, which allow only `https://discord.com`, `https://ptb.discord.com` and `https://canary.discord.com`. Everything else in the CSP is unchanged. `/api/*` is never frameable.

`GET /api/activity/config` returns the public client id. Both endpoints answer 503 until Discord credentials are configured.

## Developer Portal settings

- Enable **Activities** for the application.
- Under Activities > URL Mappings, map prefix `/` to `checkers.jevplay.games`.
- Ranked play, channel context and `/play checkers` launch links still work only through the existing signed interaction flow; an Activity session is an ordinary signed-in session.

## Entry Point command

Enabling Activities makes Discord create a primary Entry Point command. `npm run discord:register` upserts `/play` with a single `POST`, so it does not touch that command. Do not replace it with a bulk overwrite (`PUT .../commands`) unless the Entry Point command is included.
