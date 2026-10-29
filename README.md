# opencode-anthropic-console-login

An OpenCode 2 plugin that adds **Anthropic Console (API usage billing)** to `/connect` for the built-in `anthropic`
provider. It signs in with your Console account instead of a claude.ai subscription and needs no API key from an admin.

## Use

Add the plugin to `opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-anthropic-console-login"]
}
```

Then run `/connect`, pick **Anthropic**, and choose **Anthropic Console (API usage billing)**. Sign in in the browser.
You only do this once per machine.

## How it works

1. The plugin registers an OAuth method (`console`) on the `anthropic` integration. `/connect` shows the sign-in URL
   and waits for the browser to finish (`mode: "auto"`).
2. `beginLogin` in `src/oauth.ts` starts a callback server on `localhost:53693`, uses PKCE with scope
   `org:create_api_key user:profile`, and exchanges the code for an OAuth token.
3. It calls Anthropic's `create_api_key` endpoint with that token. The minted Console API key is stored in the
   credential's `metadata.apiKey`, next to the OAuth access and refresh tokens.
4. An AI SDK hook (`src/provider.ts`) wraps `fetch` for the `anthropic` provider. Each request gets `x-api-key` set to
   the Console key, plus the identity headers, and any `authorization` header is dropped.
5. When the OAuth token is about to expire, the plugin refreshes it and mints a fresh key. A `401` triggers one
   re-mint and one retry (not for streaming request bodies, which cannot be replayed).

Refreshed or re-minted credentials are kept in memory only, because the plugin API has no call to persist them.
After a restart OpenCode loads the stored credential again, and the plugin refreshes it again when needed. If the
refresh fails, the connection is marked `needs_auth`; run `/connect` and sign in again.

## Rate limiting

Requests answered with `429` or `529` are retried according to `retry-after` (seconds or an HTTP date), up to
`OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` (default 30000 ms). If the server asks for a longer wait, the response is returned
unchanged so the error surfaces instead of the session hanging.

Keys from one organization share a single quota. Retrying, or minting a new key, cannot get around an
organization-wide limit; the plugin only waits out short limits.

```bash
export OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS=60000  # 60 seconds
```

## Known limitation

The hook sets `options.fetch` on the AI SDK provider options. That this is honoured is based on the type definitions
of `@opencode/plugin` 2.2.1 and has not been confirmed against a running OpenCode.

## Notes

- Port `53693` must be free during login.
- The sign-in uses Claude Code's OAuth client ID, so the Console consent screen looks like Claude Code's.
- Each `/connect` login saves a new account. Remove old ones with `/connect` or `opencode auth`; don't edit the database.
- Needs Node 20 or newer.

## Develop

```sh
npm install
npm test
```

## Credits

The OAuth flow is ported from [jvortmann/pi-anthropic-console-login](https://github.com/jvortmann/pi-anthropic-console-login)
(MIT).
