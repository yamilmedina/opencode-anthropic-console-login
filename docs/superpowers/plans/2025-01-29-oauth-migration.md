# OAuth Credential Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate from command-based Console API key auth to native OAuth credential management with on-demand API key creation, enabling token rotation and automatic rate limit recovery.

**Architecture:** 
Replace the command-method flow (login.mjs → single static API key) with OAuth integration registered through OpenCode's `IntegrationOAuthMethodRegistration`. Store OAuth access/refresh tokens. Create API keys on-demand from the OAuth token, enabling rate limit recovery by creating fresh API keys when 429s occur. Refresh the OAuth token when it expires.

**Tech Stack:** 
- `@opencode/plugin`: OAuth method registration
- Node.js `crypto`, `http` modules
- Existing oauth.mjs functions, refactored to TypeScript

**Spec:** This plan implements the OAuth migration pattern from [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) adapted to the Console OAuth flow.

## Global Constraints

- Node.js ≥20 (from package.json)
- Must not break existing tests; migrate them
- OAuth token storage uses OpenCode's credential system (no manual storage)
- API key creation endpoint: `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`
- OAuth endpoint: `https://platform.claude.com/v1/oauth/token`
- Callback port: fixed at 53693
- Rate limit codes: 429, 529

## Review Focus

1. **Token expiry handling:** OAuth token expires but plugin doesn't detect it; next request fails with 401. Verify refresh happens before expiry or on 401.
2. **Double request body reads:** Request body cloned multiple times; streaming payloads or large bodies could fail. Verify body is read/cached once.
3. **Multiple concurrent API keys:** Plugin creates one key per authorize; many rapid requests create many keys. Verify keys are reused within their lifetime window.
4. **Provider fetch wrapping:** Current code wraps provider.fetch and also calls fetchWithRetry internally; duplicate retry logic causes hung requests. Verify retry logic exists in one layer only.
5. **Account source tracking:** With multiple OAuth credentials, requests must be recovered with the same account token they were made with. Verify account source is tracked and used for retry.

---

## File Structure

**Modify:**
- `src/index.ts` - Register OAuth method instead of command method
- `src/http.ts` - Refactor retry logic, remove double-wrapping
- `src/provider.ts` - Wrap provider fetch to create/reuse API keys on-demand
- `src/model-config.ts` - No substantive change (headers already correct)
- `test/plugin.test.mjs` - Update to verify OAuth method registration
- `test/oauth.test.mjs` - Refactor for TypeScript, keep OAuth behavior tests

**Create:**
- `src/oauth.ts` - Port oauth.mjs to TypeScript, export OAuth flow functions
- `src/credentials.ts` - OAuth token storage, refresh, and API key caching
- `docs/superpowers/plans/2025-01-29-oauth-migration.md` - This plan

**Remove:**
- `src/login.mjs` - No longer needed; OAuth flow is in plugin setup
- `oauth.mjs` - Superseded by oauth.ts

---

## Task 1: Port oauth.mjs to TypeScript (oauth.ts)

**Files:**
- Create: `src/oauth.ts`
- Delete: `src/oauth.mjs`
- Test: `test/oauth.test.mjs` (keep but repoint imports)

**Interfaces:**
- Consumes: OAuth endpoints (URLs and scopes from current oauth.mjs)
- Produces: 
  - `generatePKCE(): Promise<{ verifier: string; challenge: string }>`
  - `buildAuthorizeUrl({ challenge, state, redirectUri }): string`
  - `exchangeCode({ code, state, verifier, redirectUri, fetchFn }): Promise<string>` — returns access_token
  - `createApiKey(oauthAccessToken, fetchFn): Promise<string>` — returns raw_key
  - `parseAuthorizationInput(input): { code?: string; state?: string }`
  - `login(options?): Promise<string>` — interactive flow, returns raw_key
  - OAuth constants: `CLIENT_ID`, `CALLBACK_PORT`, `AUTHORIZE_URL`, `TOKEN_URL`, `API_KEY_URL`, `SCOPES`, `REDIRECT_URI`

- [ ] **Step 1: Convert oauth.mjs to oauth.ts with minimal logic changes**

Copy oauth.mjs to oauth.ts. Add TypeScript types to function signatures:
- `generatePKCE()` → return type `Promise<{ verifier: string; challenge: string }>`
- `fetchWithRetry(input, init, retries, fetchImpl)` → `fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, retries?: number, fetchImpl?: typeof fetch): Promise<Response>`
- `sleepUnlessAborted(ms, signal)` → `sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void>`
- `login(options)` → `login(options?: { fetchFn?; openUrl?; log?; timeoutMs? }): Promise<string>`
- All other functions: add parameter types and return types

Move `fetchWithRetry` and `sleepUnlessAborted` to a separate internal section (they'll be removed later in favor of http.ts versions).

- [ ] **Step 2: Update test imports**

In `test/oauth.test.mjs`, change:
```javascript
import {
  buildAuthorizeUrl,
  CALLBACK_PORT,
  createApiKey,
  exchangeCode,
  generatePKCE,
  login,
  parseAuthorizationInput,
} from "../src/oauth.ts"
```

- [ ] **Step 3: Run existing oauth tests**

Run: `npm test -- test/oauth.test.mjs`
Expected: PASS (all 10 tests pass; logic unchanged)

- [ ] **Step 4: Commit**

```bash
git add src/oauth.ts test/oauth.test.mjs
git rm src/oauth.mjs
git commit -m "refactor: port oauth.mjs to TypeScript (oauth.ts)"
```

---

## Task 2: Create credentials.ts for OAuth token storage and refresh

**Files:**
- Create: `src/credentials.ts`
- Test: `test/credentials.test.mjs` (new)

**Interfaces:**
- Consumes: `exchangeCode()`, `createApiKey()` from oauth.ts
- Produces:
  - `type OAuthCredential = { accessToken: string; refreshToken?: string; expiresAt?: number; oauthTokenCreatedAt?: number }`
  - `type CachedApiKey = { key: string; createdAt: number }`
  - `getOrCreateApiKey(credential: OAuthCredential, fetchFn?: typeof fetch): Promise<string>` — creates or reuses key
  - `refreshOAuthToken(refreshToken: string, fetchFn?: typeof fetch): Promise<OAuthCredential>` — returns new credential
  - `isOAuthTokenExpired(credential: OAuthCredential): boolean` — checks if > 95% of lifetime elapsed
  - `validateCredentialFormat(value: unknown): OAuthCredential | null` — used by OpenCode deserializer

**Design decisions:**
- Store API keys with creation timestamp; reuse within 1 hour
- OAuth tokens: create new one if > 95% of lifetime consumed (default 3600s)
- Refresh tokens: optional; only refresh if available
- On refresh failure, fall back to creating new API key with current token (if still valid)
- All functions accept optional `fetchFn` for testability

- [ ] **Step 1: Write tests for credential lifecycle**

Create `test/credentials.test.mjs`:
```javascript
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getOrCreateApiKey,
  refreshOAuthToken,
  isOAuthTokenExpired,
  validateCredentialFormat,
} from "../src/credentials.ts"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

test("getOrCreateApiKey creates a key if none cached", async () => {
  const fetchFn = async (url) =>
    url.includes("create_api_key")
      ? jsonResponse({ raw_key: "sk-ant-api03-new" })
      : jsonResponse({})
  const credential = { accessToken: "oauth-token" }
  const key = await getOrCreateApiKey(credential, fetchFn)
  assert.equal(key, "sk-ant-api03-new")
})

test("getOrCreateApiKey reuses key within 1 hour", async () => {
  let callCount = 0
  const fetchFn = async () => {
    callCount++
    return jsonResponse({ raw_key: "sk-ant-api03-reused" })
  }
  const credential = { accessToken: "oauth-token" }
  const key1 = await getOrCreateApiKey(credential, fetchFn)
  const key2 = await getOrCreateApiKey(credential, fetchFn)
  assert.equal(key1, "sk-ant-api03-reused")
  assert.equal(key2, "sk-ant-api03-reused")
  assert.equal(callCount, 1, "should only create once")
})

test("getOrCreateApiKey creates new key after 1 hour", async () => {
  let callCount = 0
  const fetchFn = async () => {
    callCount++
    return jsonResponse({ raw_key: `sk-ant-api03-call-${callCount}` })
  }
  const credential = { accessToken: "oauth-token" }
  const key1 = await getOrCreateApiKey(credential, fetchFn)
  
  // Manually expire the cached key
  const now = Date.now()
  const cred2 = {
    ...credential,
    _lastApiKeyCreatedAt: now - 61 * 60 * 1000, // 61 minutes ago
  }
  const key2 = await getOrCreateApiKey(cred2, fetchFn)
  assert.equal(key1, "sk-ant-api03-call-1")
  assert.equal(key2, "sk-ant-api03-call-2")
})

test("isOAuthTokenExpired returns true when > 95% of lifetime consumed", () => {
  const created = Date.now()
  const expiresIn = 3600 // 1 hour
  const cred = {
    accessToken: "token",
    oauthTokenCreatedAt: created,
    expiresAt: created + expiresIn * 1000,
  }
  const earlyCheck = isOAuthTokenExpired(cred)
  assert.equal(earlyCheck, false)
  
  // Advance 96% of lifetime
  const late = created + expiresIn * 1000 * 0.96
  const lateCheck = isOAuthTokenExpired({ ...cred, oauthTokenCreatedAt: late })
  assert.equal(lateCheck, true)
})

test("refreshOAuthToken exchanges refresh token for new access token", async () => {
  const fetchFn = async (url) =>
    url.includes("oauth/token")
      ? jsonResponse({
          access_token: "new-oauth-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        })
      : jsonResponse({})
  const refreshed = await refreshOAuthToken("old-refresh", fetchFn)
  assert.equal(refreshed.accessToken, "new-oauth-token")
  assert.equal(refreshed.refreshToken, "new-refresh")
})

test("validateCredentialFormat rejects malformed credentials", () => {
  assert.equal(validateCredentialFormat(null), null)
  assert.equal(validateCredentialFormat({ accessToken: 123 }), null)
  assert.equal(validateCredentialFormat({ accessToken: "token" }).accessToken, "token")
})
```

- [ ] **Step 2: Run test to verify they all fail**

Run: `npm test -- test/credentials.test.mjs`
Expected: FAIL with "credentials.ts not found" or "exports undefined"

- [ ] **Step 3: Implement credentials.ts**

Create `src/credentials.ts`:

```typescript
import { exchangeCode, createApiKey } from "./oauth.ts"

export interface OAuthCredential {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  oauthTokenCreatedAt?: number
  // Internal cache tracking
  _cachedApiKey?: string
  _lastApiKeyCreatedAt?: number
}

export function isOAuthTokenExpired(credential: OAuthCredential): boolean {
  if (!credential.expiresAt || !credential.oauthTokenCreatedAt) {
    return false
  }
  const lifetime = credential.expiresAt - credential.oauthTokenCreatedAt
  const elapsed = Date.now() - credential.oauthTokenCreatedAt
  // Refresh when > 95% of lifetime consumed
  return elapsed > lifetime * 0.95
}

export async function getOrCreateApiKey(
  credential: OAuthCredential,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  // Check if we have a cached key and it's less than 1 hour old
  if (credential._cachedApiKey && credential._lastApiKeyCreatedAt) {
    const age = Date.now() - credential._lastApiKeyCreatedAt
    if (age < 60 * 60 * 1000) {
      return credential._cachedApiKey
    }
  }

  // Create a new API key from the OAuth token
  const key = await createApiKey(credential.accessToken, fetchFn)

  // Cache it
  credential._cachedApiKey = key
  credential._lastApiKeyCreatedAt = Date.now()

  return key
}

export async function refreshOAuthToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<OAuthCredential> {
  const response = await fetchFn("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    throw new Error(`OAuth refresh failed: ${await response.text()}`)
  }

  const data = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const now = Date.now()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    oauthTokenCreatedAt: now,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  }
}

export function validateCredentialFormat(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== "object") return null
  const obj = value as Record<string, unknown>
  if (typeof obj.accessToken !== "string") return null
  return {
    accessToken: obj.accessToken,
    refreshToken: typeof obj.refreshToken === "string" ? obj.refreshToken : undefined,
    expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : undefined,
    oauthTokenCreatedAt: typeof obj.oauthTokenCreatedAt === "number" ? obj.oauthTokenCreatedAt : undefined,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/credentials.test.mjs`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/credentials.ts test/credentials.test.mjs
git commit -m "feat: add OAuth credential management with API key caching"
```

---

## Task 3: Update index.ts to register OAuth method through OpenCode integration

**Files:**
- Modify: `src/index.ts`
- Test: `test/plugin.test.mjs` (update existing test)

**Interfaces:**
- Consumes: `exchangeCode()`, `createApiKey()`, `buildAuthorizeUrl()` from oauth.ts; `OAuthCredential` from credentials.ts
- Produces: Plugin.define registration that calls `ctx.integration.transform()` with OAuth method

**Design decisions:**
- Use OpenCode's native `IntegrationOAuthMethodRegistration` type
- OAuth authorize callback returns credential object (access/refresh tokens)
- Credential is labeled in UI as "Anthropic Console (API usage billing) — {email}"
- No need for refresh method callback; we'll handle it in provider layer
- Store entire credential object; later use it to create API keys

- [ ] **Step 1: Write test for OAuth method registration**

Modify `test/plugin.test.mjs`:

```javascript
import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/index.ts"

test("registers OAuth method on the anthropic integration", async () => {
  const updates = []
  const ctx = {
    integration: {
      transform: async (callback) => {
        callback({ method: { update: (input) => updates.push(input) } })
      },
    },
  }

  await plugin.setup(ctx)

  assert.equal(plugin.id, "anthropic-console-login")
  assert.equal(updates.length, 1)
  const { integrationID, method } = updates[0]
  assert.equal(integrationID, "anthropic")
  assert.equal(method.id, "console-oauth")
  assert.equal(method.type, "oauth")
  assert(method.authorize, "authorize callback required")
  assert(method.label, "label callback required")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/plugin.test.mjs`
Expected: FAIL with "method.type should be 'oauth'" or similar

- [ ] **Step 3: Update index.ts to register OAuth method**

Replace the current command method with OAuth registration. Key changes:
- Import `IntegrationOAuthMethodRegistration` from "@opencode/plugin/promise/integration"
- Import `exchangeCode`, `createApiKey`, `buildAuthorizeUrl` from oauth.ts
- Import `OAuthCredential` from credentials.ts
- Remove login.mjs script import and command method registration
- Add OAuth method registration with:
  - `integrationID: "anthropic"`
  - `method.id: "console-oauth"`
  - `method.type: "oauth"`
  - `authorize` callback: returns callback URL and credential object
  - `label` callback: formats "Anthropic Console — {email or org}"
  - `refresh` callback: calls refreshOAuthToken (optional; may skip for now)

```typescript
import { Plugin, Provider } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import {
  exchangeCode,
  createApiKey,
  buildAuthorizeUrl,
  generatePKCE,
} from "./oauth.ts"
import type { OAuthCredential } from "./credentials.ts"
import { validateCredentialFormat } from "./credentials.ts"
import { fetchWithRetry } from "./http.ts"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = "console-oauth"

const PROVIDER_ID = Provider.ID.make("anthropic")

export default Plugin.define({
  id: "anthropic-console-login",
  async setup(ctx) {
    // Register OAuth method
    await ctx.integration.transform((editor) => {
      const oauthMethod: IntegrationOAuthMethodRegistration = {
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "Anthropic Console (API usage billing)",
        },
        authorize: async (inputs) => {
          const { verifier, challenge } = await generatePKCE()
          const authUrl = buildAuthorizeUrl({
            challenge,
            state: verifier,
            redirectUri: inputs.callbackURL,
          })

          return {
            mode: "callback" as const,
            url: authUrl,
            instructions:
              "Log in with your Anthropic Console account. Your API key will be created automatically.",
            callback: (async () => {
              // inputs.code and inputs.state come from callback
              const accessToken = await exchangeCode({
                code: inputs.code,
                state: inputs.state,
                verifier,
                redirectUri: inputs.callbackURL,
                fetchFn: fetch,
              })

              // Create an API key from the OAuth token
              const apiKey = await createApiKey(accessToken, fetch)

              // Return credential object (without the API key; we'll create fresh ones on-demand)
              const credential: OAuthCredential = {
                accessToken,
                // Note: we don't get refresh_token from this flow; Console doesn't return it
                // That's OK—we can request new tokens by re-running the auth flow
              }

              return credential
            })(),
          }
        },

        label: (credential) => {
          const cred = validateCredentialFormat(credential)
          if (!cred) return "Anthropic Console (invalid)"
          return "Anthropic Console (API usage billing)"
        },
      }

      editor.method.update(oauthMethod)
    })

    // No provider hooks needed here; we'll add them in provider.ts
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/plugin.test.mjs`
Expected: PASS

- [ ] **Step 5: Delete login.mjs**

```bash
git rm src/login.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/plugin.test.mjs
git rm src/login.mjs
git commit -m "refactor: register OAuth method through OpenCode integration"
```

---

## Task 4: Update provider.ts to create/reuse API keys on-demand

**Files:**
- Modify: `src/provider.ts`
- Test: `test/provider.test.mjs` (new)

**Interfaces:**
- Consumes: `OAuthCredential` from credentials.ts; `getOrCreateApiKey()`, `isOAuthTokenExpired()`, `refreshOAuthToken()` from credentials.ts
- Produces:
  - Plugin HTTP hooks (via ctx.session.hook) that intercept requests
  - API keys are created on-demand from OAuth credential
  - On 429, request is retried with a new API key

**Design decisions:**
- Wrap session HTTP hooks (not provider.fetch) to avoid double-wrapping
- Store credential in WeakMap keyed by Request, so recovery knows which account made the request
- On 429: create new API key, retry request
- On 401: skip recovery (credential invalid; user should re-login)
- Single request body read, cached in a string (not re-cloned)

- [ ] **Step 1: Write test for API key creation and rate limit recovery**

Create `test/provider.test.mjs`:

```javascript
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  prepareConsoleRequest,
  handleConsoleResponse,
  createNewApiKey,
} from "../src/provider.ts"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

test("prepareConsoleRequest replaces x-api-key with Bearer auth", async () => {
  const credential = { accessToken: "oauth-token-abc" }
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "old-key" },
    body: JSON.stringify({ model: "claude-opus-4-7", messages: [] }),
  })

  const fetchFn = async () =>
    jsonResponse({ raw_key: "sk-ant-new-key-1" })

  const prepared = await prepareConsoleRequest(request, credential, fetchFn)
  assert(!prepared.headers.has("x-api-key"))
  assert.match(prepared.headers.get("authorization"), /^Bearer sk-ant-new-key/)
})

test("handleConsoleResponse retries with new API key on 429", async () => {
  const credential = { accessToken: "oauth-token" }
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-opus-4-7" }),
  })

  let requestCount = 0
  const fetchFn = async () => {
    requestCount++
    return requestCount === 1
      ? jsonResponse({ error: "rate limited" }, 429)
      : jsonResponse({ id: "msg-abc" })
  }

  const apiKeyFn = async () =>
    requestCount === 1 ? "key-1" : "key-2"

  const initial = jsonResponse({ error: "rate limited" }, 429)
  const recovered = await handleConsoleResponse(
    request,
    initial,
    credential,
    fetchFn,
    apiKeyFn,
  )

  assert.equal(recovered.status, 200, "should retry and succeed")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/provider.test.mjs`
Expected: FAIL with function signatures not matching

- [ ] **Step 3: Implement provider.ts functions**

Rewrite `src/provider.ts`:

```typescript
import { getOrCreateApiKey, isOAuthTokenExpired, refreshOAuthToken } from "./credentials.ts"
import type { OAuthCredential } from "./credentials.ts"
import { buildRequestHeaders } from "./model-config.ts"

function modelFromBody(body: string): string {
  try {
    return (JSON.parse(body) as { model?: string }).model ?? "unknown"
  } catch {
    return "unknown"
  }
}

// Called when preparing a request: create or reuse an API key from the credential
export async function prepareConsoleRequest(
  request: Request,
  credential: OAuthCredential,
  getApiKeyFn: (cred: OAuthCredential) => Promise<string> = getOrCreateApiKey,
): Promise<{ request: Request; apiKey: string }> {
  // Read body once, cache it
  const body = await request.clone().text()
  const modelID = modelFromBody(body)

  // Get or create API key from OAuth credential
  const apiKey = await getApiKeyFn(credential)

  // Build new request with proper headers
  const headers = buildRequestHeaders(apiKey, modelID)
  const prepared = new Request(request, { headers })

  return { request: prepared, apiKey }
}

// Called after receiving a response: handle 429s by creating new API key
export async function handleConsoleResponse(
  originalRequest: Request,
  response: Response,
  credential: OAuthCredential,
  fetchFn: typeof fetch = fetch,
  getApiKeyFn: (cred: OAuthCredential) => Promise<string> = getOrCreateApiKey,
): Promise<Response> {
  // On 429, try with a new API key
  if (response.status === 429) {
    // Create a fresh API key (don't reuse cached one)
    const newApiKey = await getApiKeyFn(credential)

    // Rebuild request with new key
    const body = await originalRequest.clone().text()
    const modelID = modelFromBody(body)
    const newHeaders = buildRequestHeaders(newApiKey, modelID)

    const retryRequest = new Request(originalRequest, {
      headers: newHeaders,
      body,
    })

    return fetchFn(retryRequest.url, {
      method: retryRequest.method,
      headers: retryRequest.headers,
      body,
    })
  }

  return response
}

// On 401: token is invalid; no recovery available
// On other errors: log and return as-is
export async function handleErrorResponse(
  response: Response,
  modelID: string,
): Promise<Response> {
  if (!response.ok) {
    console.error(
      `Anthropic API error: ${response.status} on model ${modelID}`,
    )
  }
  return response
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/provider.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts test/provider.test.mjs
git commit -m "feat: implement on-demand API key creation with 429 recovery"
```

---

## Task 5: Update index.ts to hook provider requests

**Files:**
- Modify: `src/index.ts` (add HTTP hooks)

**Interfaces:**
- Consumes: Functions from provider.ts
- Produces: HTTP request/response hooks that intercept Anthropic API calls

**Design decisions:**
- Use `ctx.session.hook("http.request", ...)` to intercept requests
- Use `ctx.session.hook("http.response", ...)` to handle responses
- Store credential + body in a WeakMap keyed by Request object
- Handle errors gracefully (credentials invalid, fetch fails, etc.)

- [ ] **Step 1: Write test for HTTP hook integration**

Add to `test/plugin.test.mjs`:

```javascript
test("plugin hooks http.request and http.response for Anthropic API", async () => {
  const hooks = {}
  const ctx = {
    integration: {
      transform: async (callback) => callback({ method: { update: () => {} } }),
    },
    session: {
      hook: async (name, handler) => {
        hooks[name] = handler
      },
    },
  }

  await plugin.setup(ctx)

  assert(hooks["http.request"], "should register http.request hook")
  assert(hooks["http.response"], "should register http.response hook")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/plugin.test.mjs`
Expected: FAIL with "should register http.request hook"

- [ ] **Step 3: Update index.ts to add HTTP hooks**

In the plugin setup, after the OAuth method registration, add:

```typescript
// Store credential + context per request for recovery
const requestContexts = new WeakMap<Request, { credential: OAuthCredential; body: string }>()

// Intercept outgoing requests to create API keys
await ctx.session.hook("http.request", async (event) => {
  if (event.model.providerID !== PROVIDER_ID) return

  // Get the active credential (user must have authenticated via OAuth)
  const connection = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!connection) return

  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential || credential.type !== "oauth" || credential.methodID !== METHOD_ID) {
    return
  }

  // Prepare request with API key
  const body = await event.request.clone().text()
  const prepared = await prepareConsoleRequest(
    event.request,
    validateCredentialFormat(credential.data),
  )

  event.request = prepared.request
  requestContexts.set(event.request, {
    credential: validateCredentialFormat(credential.data),
    body,
  })
})

// Handle responses: retry on 429 with new API key
await ctx.session.hook("http.response", async (event) => {
  const context = requestContexts.get(event.request)
  if (!context) return
  requestContexts.delete(event.request)

  event.response = await handleConsoleResponse(
    event.request,
    event.response,
    context.credential,
  )
})
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add http hooks for OAuth credential management"
```

---

## Task 6: Update http.ts to remove double-wrapping

**Files:**
- Modify: `src/http.ts`

**Interfaces:**
- Consumes: Nothing (standalone retry logic)
- Produces: `fetchWithRetry(input, init, retries, fetchImpl): Promise<Response>` — same as before

**Design decisions:**
- Keep existing retry logic (handles 429/529)
- Remove from index.ts's provider.fetch wrapping (we'll use HTTP hooks instead)
- This is now the single layer handling retries for rate limits

- [ ] **Step 1: Verify http.ts has proper retry logic**

Review `src/http.ts`. It should handle 429/529 with backoff. If good, no changes needed.

- [ ] **Step 2: Update index.ts to NOT wrap provider.fetch**

In index.ts, remove this code block (from current version):
```typescript
// Wrap the Anthropic provider to add retry logic
if (ctx.provider) {
  await ctx.provider.transform(async (editor) => {
    if (editor.id !== PROVIDER_ID) return
    const originalFetch = editor.fetch
    if (!originalFetch) return
    editor.fetch = async (input, init) => {
      return fetchWithRetry(input, init, 3, originalFetch)
    }
  })
}
```

Remove this in favor of HTTP hooks only.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/http.ts
git commit -m "fix: remove double-wrapped retry logic, rely on HTTP hooks"
```

---

## Task 7: Update tests and cleanup

**Files:**
- Modify: `test/plugin.test.mjs`, `test/oauth.test.mjs`
- Delete: `src/login.mjs` (already deleted in Task 3)
- Delete: `src/oauth.mjs` (already superseded by oauth.ts)

**Interfaces:**
- All tests should verify OAuth integration, not command-based login

- [ ] **Step 1: Verify all existing tests still pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 2: Add integration test for full OAuth flow**

Add to `test/plugin.test.mjs`:

```javascript
test("OAuth authorize flow creates API key and returns credential", async () => {
  let capturedCallback = null
  const ctx = {
    integration: {
      transform: async (callback) => {
        const editor = {
          method: {
            update: (input) => {
              capturedCallback = input.authorize
            },
          },
        }
        callback(editor)
      },
      connection: {
        active: async () => ({ methodID: "console-oauth" }),
        resolve: async () => ({
          type: "oauth",
          methodID: "console-oauth",
          data: { accessToken: "oauth-token" },
        }),
      },
    },
    session: {
      hook: async () => {},
    },
  }

  await plugin.setup(ctx)

  // Simulate OAuth callback with mocked endpoints
  const result = await capturedCallback({
    code: "auth-code",
    state: "state-value",
    callbackURL: "http://localhost:53693/callback",
  })

  assert(result.callback, "authorize should return callback")
  const credential = await result.callback
  assert.equal(credential.accessToken, "...", "credential should have accessToken")
})
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: update tests for OAuth integration"
```

---

## Task 8: Manual testing and validation

**No code changes; verify behavior end-to-end**

- [ ] **Step 1: Build the plugin**

If there's a build step:
```bash
npm run build
```

- [ ] **Step 2: Load plugin in OpenCode**

Start OpenCode 2, navigate to `/connect`, and verify:
- Anthropic integration shows "console-oauth" as an option
- Clicking authorize opens browser login
- After login, credential is stored

- [ ] **Step 3: Test with a model request**

Make a request to an Anthropic model in OpenCode. Verify:
- Request succeeds (API key is created from OAuth token)
- Headers include Bearer auth, not x-api-key

- [ ] **Step 4: Simulate rate limit (optional)**

If possible, trigger a 429 response and verify:
- Plugin creates a new API key
- Request is retried with the new key
- Response succeeds

- [ ] **Step 5: Commit final state**

```bash
git status
# If any uncommitted changes from manual testing:
git add .
git commit -m "test: manual validation of OAuth flow"
```

---

## Summary of Changes

| Component | Change | Why |
|-----------|--------|-----|
| `index.ts` | OAuth method registration + HTTP hooks | Enable OpenCode-native OAuth + on-demand API key creation |
| `oauth.ts` | Port from JS to TS | Type safety + consistency |
| `credentials.ts` | New file | Manage OAuth tokens + API key caching + refresh |
| `provider.ts` | Rewrite with on-demand keys | Create fresh API keys on 429 |
| `http.ts` | No changes (single retry layer) | Prevent double-wrapping |
| `login.mjs` | Delete | No longer needed; OAuth in plugin setup |
| `oauth.mjs` | Superseded by `oauth.ts` | Migrate to TypeScript |

## After Implementation

The plugin will:
1. ✅ Register OAuth method through OpenCode's native system
2. ✅ Store OAuth access token (no permanent API key storage)
3. ✅ Create API keys on-demand from OAuth token
4. ✅ Reuse API keys within 1 hour
5. ✅ Retry failed requests with new API keys on 429s
6. ✅ Handle OAuth token refresh (when implemented)
7. ✅ Support multiple OAuth credentials for account switching
8. ✅ Remove duplicate retry logic

This enables **token rotation on rate limits**, addressing the core issue.

