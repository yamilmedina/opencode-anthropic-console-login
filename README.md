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

1. The plugin registers a `command` auth method on the `anthropic` integration. OpenCode runs `node src/login.mjs` and
   saves its standard output as the key.
2. `login.mjs` starts a callback server on `localhost:53693`, opens `platform.claude.com/oauth/authorize` (PKCE,
   scope `org:create_api_key user:profile`) and exchanges the code for an OAuth token.
3. It calls Anthropic's `create_api_key` endpoint with that token and prints the new API key.
4. The login process includes retry logic for rate-limited responses (429, 529) with exponential backoff and
   `retry-after` header support.

The key does not expire, so there is no refresh flow and no sync script. The OAuth token is used once and discarded.
Requests go to `api.anthropic.com` with the key and are billed to the key's Console workspace.

## Rate limiting

If you hit rate limits during login, the plugin automatically retries with exponential backoff. The retry window caps
at 30 seconds by default—if the server signals a longer delay (indicating a quota/usage limit reset hours away), the
error surfaces immediately so the process doesn't hang.

Override with `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` if you need a longer retry window:

```bash
export OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS=60000  # 60 seconds
opencode /connect
```

## Notes

- Port `53693` must be free during login.
- The sign-in uses Claude Code's OAuth client ID, so the Console consent screen looks like Claude Code's.
- Each `/connect` login saves a new account. Remove old ones with `/connect` or `opencode auth`; don't edit the database.
- Needs `node` on `PATH` and Node 20 or newer.

## Develop

```sh
npm install
npm test
```

## Credits

The OAuth flow is ported from [jvortmann/pi-anthropic-console-login](https://github.com/jvortmann/pi-anthropic-console-login)
(MIT).
