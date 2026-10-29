# Honest Console plugin — spec

## Goal
OpenCode 2 plugin: sign in to Anthropic Console via OAuth in `/connect`, use the minted Console API key for
`anthropic` requests, and behave honestly under rate limits.

## Verified facts (@opencode/plugin 2.2.1)
- OAuth registration: `ctx.integration.transform(e => e.method.update({ integrationID, method: {id, type:"oauth", label}, authorize, refresh?, label? }))`.
  `authorize(answer) -> {url, instructions, mode:"auto", callback: Promise<Credential.OAuth>} | {mode:"code", callback:(code)=>Promise<Credential.OAuth>}`.
- `Credential.OAuth = { type:"oauth", methodID, access, refresh, expires:int, metadata?: Record<string,unknown> }`.
- `ProviderEditor` has no `fetch`. Request customization goes through `ctx.aisdk.hook("sdk", {model, package, options, sdk?})`.
- `ctx.integration.connection.active(id)` / `.resolve(conn)` return the stored credential.

## Decisions
- The minted Console API key is stored in `credential.metadata.apiKey`; it does not expire. OAuth `access`/`refresh`/`expires` are kept so the key can be re-minted.
- No API-key rotation: keys from one Console org share one org quota, so a fresh key cannot escape a 429.
- Rate limits: honour `retry-after` (seconds or HTTP-date) up to `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` (default 30000); beyond that return the 429 unchanged. One retry layer only.
- Re-mint the key at most once per request, only on 401, then retry once.
- Console API requests authenticate with `x-api-key` (the key is an API key); the earlier `Authorization: Bearer` rewrite is removed unless Task 3's check shows otherwise.

## Non-goals
Multi-account rotation; changing the OAuth client ID or scopes.
