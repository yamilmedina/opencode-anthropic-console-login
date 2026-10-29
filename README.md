# opencode-anthropic-console-login

An OpenCode 2 plugin that adds **Anthropic Console (API usage billing)** to `/connect`.
It uses your Console organization account to create an API key through OAuth.
Usage is billed to that organization, separately from a Claude subscription.

## Install

Run `npm ci` in this checkout. Add its absolute path to `plugins` in
`~/.config/opencode/opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": ["/absolute/path/to/opencode-anthropic-console-login"]
}
```

Replace the example path with your checkout's absolute path. Remove `opencode-claude-auth`
when switching to this plugin, and keep unrelated plugins. Both auth plugins modify
Anthropic requests, so loading both can cause conflicting authentication.

Restart OpenCode, run `/connect`, select **Anthropic**, and choose
**Anthropic Console (API usage billing)**. Complete the browser login and select the
Console connection if a subscription connection was previously active.

Requires OpenCode 2, `@opencode/plugin` 2.2.1 or compatible, and Node 22.18 or newer
on PATH for OAuth transport and the development commands. Port `53693` must be free during login.

## OAuth runtime

When loaded in OpenCode's Bun runtime, the plugin runs Console OAuth requests through
Node's fetch and TLS stack, matching Pi's runtime. This applies to code exchange, token
refresh, and key creation. Model requests remain on OpenCode's native transport.

Codes, tokens, and request bodies reach the Node process through a private stdin pipe.
They are never passed as command-line arguments. OAuth transport has a 60-second timeout
and returns server errors unchanged. A `429` can still occur and includes diagnostic headers.

## Request handling

The plugin uses OpenCode 2's native session HTTP hooks for the Anthropic provider.
It sets `x-api-key` on HTTPS requests to `api.anthropic.com` and removes the OAuth
`authorization` header. Other providers, endpoints, and authentication methods pass
through unchanged.

Like Pi's Console provider, the plugin prepends the Claude Code identity block
(`You are Claude Code, Anthropic's official CLI for Claude.`) to the system prompt of
`/v1/messages` requests. SDK headers, tool names, and streaming responses are preserved.
The plugin supplies an API version and user agent only when absent. It adds no session
or browser-access headers.

## Credentials and refresh

The Console login stores an OAuth access token, a refresh token, and an API key (in
`metadata.apiKey`). Console tokens last 8 hours. About 5 minutes before expiry, OpenCode
calls the plugin's `refresh` on the next model request and stores the result. The plugin
rotates the tokens and creates a fresh API key. Anthropic retires the old refresh token,
so this stored result is what keeps you signed in.

If a refresh fails, the existing key stays in use. Sign in through `/connect` again only
if requests start failing with authentication errors. If key creation alone fails, the
rotated tokens are still stored.

Model requests use the stored key. A `401` marks that key as rejected. The next request
creates a replacement from the stored access token, shared across concurrent requests.
This replacement lives in memory only, because OpenCode persists credentials only through
`refresh`. After a restart the stored key is tried again and replaced again if needed.
The original `401` is returned without replaying a consumed request body.

## Rate limits

OpenCode handles retries for model requests. The plugin returns `429` and `529` responses
with their bodies and headers unchanged, including `retry-after`. It adds no second retry
loop and never creates a new key in response to a rate limit.

Each authorization code is exchanged once, matching Pi. A failed token exchange includes
the HTTP status, `Retry-After`, and request ID when supplied by the server. Wait for the
server-requested delay before starting a fresh login; model headers cannot fix this login error.

API-key creation and OAuth refresh use at most three attempts for `429` and `529`, respecting
`retry-after` in seconds or as an HTTP date. If the requested wait exceeds
`CONSOLE_LOGIN_MAX_RETRY_MS`, which defaults to 30000, the operation returns the
error immediately. Cancellation stops these retry waits.

This plugin cannot increase your organization's quota. A real quota limit can still
produce OpenCode's retry countdown.

## Diagnose a rate limit

Start OpenCode with `CONSOLE_LOGIN_DEBUG` set to an absolute file path:

```sh
CONSOLE_LOGIN_DEBUG=/tmp/console-login-debug.jsonl opencode
```

For model rate limits, the log records the status, `retry-after`, and Anthropic request ID.
It excludes API keys, OAuth tokens, prompts, and response bodies. Share those diagnostics
when reporting a failure.

## Develop

```sh
npm ci
npm test
npm pack --dry-run
```

Tests cover OAuth callbacks, native hook registration, request headers, concurrent key
creation, connection changes, cancellation, and rate-limit handling. A live request in
OpenCode still requires you to activate and authorize the plugin.

## Credits

The OAuth flow is ported from
[jvortmann/pi-anthropic-console-login](https://github.com/jvortmann/pi-anthropic-console-login),
under the MIT license. The native HTTP hook approach follows
[griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth).
