# Console plugin replacement

## Goal
Provide an OpenCode 2 Console OAuth login using organization API billing, as in
pi-anthropic-console-login. Replace this repository's request implementation.
The user approved proceeding on 2026-10-29. Keep active OpenCode configuration unchanged.

## Approach
Reuse the working PKCE callback flow and OpenCode integration registration.
Use native session HTTP hooks, as in the current opencode-claude-auth reference.
Replace the transport and credential coordination rather than introduce a proxy.
A separate proxy adds a service to operate and is unnecessary for this plugin.

## Request behavior
- Authenticate HTTPS requests to api.anthropic.com with the minted Console x-api-key.
- Preserve SDK headers and payloads. Supply the API version only if absent.
- Prepend the Claude Code identity block to the system prompt, as Pi does, without cache_control
  (OpenCode already uses all 4 allowed). Add no browser headers.
- Return model 429/529 responses intact. OpenCode owns model retries so retry layers do not multiply.
- Never rotate keys on a rate limit. Do not bypass provider quotas or blocks.
- Reuse a usable API key even after OAuth expiry. Refresh OAuth only when a new key is needed.
- Share credential updates across concurrent native model requests.
- A 401 invalidates that key. The next request shares one replacement operation.
  Return the original 401 rather than replay a consumed model request.
- Never replay streams or Request bodies. Never overwrite a newly selected connection with stale credentials.

## Login and packaging
Keep Console OAuth client, scopes and localhost callback. Preserve existing credential shape.
OpenCode stores the result of the method `refresh`, called before `expires`. Refresh rotates
tokens and mints a fresh key, and falls back to the existing key on failure. A key minted after
a 401 stays in memory only.
Exchange each single-use authorization code once, matching Pi. Include upstream status,
Retry-After and request ID in exchange failures. Use bounded Retry-After waits on
key creation and refresh endpoints only. Logs exclude credentials and bodies.
Ship the local TypeScript plugin and tests. Require Node 22.18+ for built-in TypeScript support.

## Verification limits
Tests cover registration, callback login, headers, concurrent credentials and retry behavior.
A real OpenCode request requires the user to activate and authorize the plugin. No live quota fix is claimed.

## Runtime compatibility correction
Fresh Pi login succeeds while OpenCode token exchange fails. A localhost differential
probe showed Node UA node and Bun UA Bun/1.4.4 with differing automatic headers.
Under Bun, isolate Console OAuth HTTP calls in a Node subprocess using piped JSON input
and a captured response. Never put credentials in argv or logs. Preserve HTTP errors,
honor cancellation, cap response size at 1 MiB, and time out at 60 seconds.
This reproduces Pi's OAuth transport without changing native model requests or identities.
The remote cause remains unconfirmed until the user completes a fresh login.
