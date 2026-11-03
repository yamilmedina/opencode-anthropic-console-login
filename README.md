# opencode-anthropic-console-login

An OpenCode 2 plugin that adds **Anthropic Console (API usage billing)** to `/connect`.
It uses your Console organization account to create an API key through OAuth.
Usage is billed to that organization, separately from a Claude subscription.

## Requirements

- OpenCode 2 with the `@opencode/plugin` 2.2.1 API. See the [OpenCode 2 plugin documentation](https://opencode.ai/v2/docs/build/plugins/). This plugin uses native session HTTP hooks.
- Node.js 22.18 or newer on `PATH`, including when you start OpenCode from a desktop app.
- An Anthropic Console account with access to an organization that can create API keys and pay for API usage.
- A browser that can reach the machine running OpenCode at `localhost:53693`. Port `53693` must be free during login.

## Install from GitHub

Install the plugin from GitHub:

```sh
opencode2 plugin add github:yamilmedina/opencode-anthropic-console-login
```

Then follow [Connect to Anthropic Console](#connect-to-anthropic-console).

## Install with an AI agent

Paste this prompt into your coding agent:

```text
Install https://github.com/yamilmedina/opencode-anthropic-console-login for OpenCode 2.

1. Read the repository's README and package.json. Confirm the repository is accessible
   and check the requirements before changing anything.
2. Check the OpenCode and Node.js versions. Use opencode2, or opencode if its version
   confirms OpenCode 2. Confirm Node.js 22.18 or newer is available on PATH.
   If a requirement is missing, report it and stop before installation.
3. Check the existing plugin configuration. If this plugin is already installed,
   verify it instead of adding a duplicate. Preserve unrelated settings and plugins.
4. Run this with the verified OpenCode 2 binary:
   opencode2 plugin add github:yamilmedina/opencode-anthropic-console-login
5. Run the same binary's plugin list command. Wait for loading to finish and confirm
   anthropic-console-login is active. Report any installation or loading errors.
6. Summarize what changed and what you verified. Then guide me through /connect,
   Anthropic, and Anthropic Console (API usage billing). I will complete the browser
   login. Explain that requests are billed to my Console organization. Leave a live
   model request to me and distinguish installation checks from live authentication.
```

## Install from a checkout

Clone or download this repository, then install its dependencies:

```sh
cd /path/to/opencode-anthropic-console-login
npm ci
pwd
```

Copy the absolute path printed by `pwd`. Add that path to `plugins` in your global
OpenCode configuration at `~/.config/opencode/opencode.json` or `opencode.jsonc`:

```json
{
	"plugins": ["/absolute/path/to/opencode-anthropic-console-login"]
}
```

Replace the example path with your checkout path. Keep the checkout in that location.
The package exports TypeScript source, which OpenCode loads directly. There is no build step.

If your configuration already has a `plugins` array, add this path to the existing array.

These instructions use a local checkout and do not require a published npm package.

## Connect to Anthropic Console

1. Restart OpenCode 2 after you edit the configuration. If you use the terminal, start it with `opencode2`.
2. Run `/connect` and select **Anthropic**.
3. Choose **Anthropic Console (API usage billing)**.
4. Open the login URL shown by OpenCode and complete the Console sign-in in your browser.
5. When the browser shows **Authentication complete**, return to OpenCode.
6. If a subscription connection was previously active, select the new Console connection.

Model requests now use the API key created for your Console organization. Anthropic bills
that organization for API usage. A Claude subscription does not cover those requests.

The browser callback must reach the OpenCode process on port `53693`. A browser on another
machine cannot complete this flow without a connection to that callback port.

## OAuth runtime

When running under Bun, the plugin sends Console OAuth requests through a separate
Node.js process. This covers code exchange, token refresh, and API-key creation.
In other runtimes, it uses the current runtime's `fetch`.
Model requests use OpenCode's native transport.

Codes, tokens, and request bodies reach the Node process through a private stdin pipe.
They are never passed as command-line arguments. The Node transport has a 60-second timeout
and preserves response status, headers, and body. OAuth operations can still receive a `429`.

## Request handling

The plugin uses OpenCode 2's native session HTTP hooks for the Anthropic provider.
It sets `x-api-key` on HTTPS requests to `api.anthropic.com` and removes the OAuth
`authorization` header. Other providers, endpoints, and authentication methods pass
through unchanged.

The plugin prepends the Claude Code identity block
(`You are Claude Code, Anthropic's official CLI for Claude.`) to the system prompt of
`/v1/messages` requests. SDK headers, tool names, and streaming responses are preserved.
The plugin supplies an API version and user agent only when absent. It adds no session
or browser-access headers.

## Credentials and refresh

The Console login stores an OAuth access token, a refresh token, and an API key in
`metadata.apiKey`. Token expiry follows the server's `expires_in` value, with a one-hour
fallback when that value is absent. When OpenCode calls the plugin's `refresh`, the plugin
renews the tokens and creates a fresh API key. OpenCode stores the returned credentials.

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

Each authorization code is exchanged once. A failed token exchange includes
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
CONSOLE_LOGIN_DEBUG=/tmp/console-login-debug.jsonl opencode2
```

For model rate limits, the log records the status, `retry-after`, and Anthropic request ID.
The rate-limit entries exclude API keys, OAuth tokens, prompts, and response bodies.
The log also records OAuth retry and refresh failures. Review the file before sharing it
with a bug report.

## Develop

```sh
npm ci
npm test
npm pack --dry-run
```

Tests cover OAuth callbacks, native hook registration, request headers, concurrent key
creation, connection changes, cancellation, and rate-limit handling. The package check lists
the files npm would publish without publishing them.

The automated tests do not establish end-to-end compatibility with your OpenCode version.
To check the complete flow, load the plugin, sign in through `/connect`, and send a model request.

An isolated OpenCode 2.2.5 server loaded this checkout as an active plugin and registered
the Console OAuth method. This check did not include a live login or a model request.

## References and credits

Implementation references:

- OAuth flow: [jvortmann/pi-anthropic-console-login](https://github.com/jvortmann/pi-anthropic-console-login), MIT license.
- Native HTTP hooks: [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth).

Copyright notices are preserved in [LICENSE](LICENSE).
