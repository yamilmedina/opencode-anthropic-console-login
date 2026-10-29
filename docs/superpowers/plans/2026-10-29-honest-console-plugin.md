# Honest Console Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OAuth login in `/connect` that stores a Console API key, uses it for `anthropic` requests, and handles rate limits honestly.

**Architecture:** `credentials.ts` adapts between OpenCode's `Credential.OAuth` and the minted key. `index.ts` registers the OAuth method. `provider.ts` hooks the AI SDK options to inject the key and a single retry-aware fetch from `http.ts`.

**Tech Stack:** TypeScript run by Node ≥20 (`node --test`), `@opencode/plugin` 2.2.1.

**Spec:** `docs/superpowers/specs/2026-10-29-honest-console-plugin.md`

## Global Constraints

- `npm test` (`node --test test/*.test.mjs`) must pass after every task; baseline is 20 passing at 711b1bc.
- Credential shape is `{ type:"oauth", methodID, access, refresh, expires, metadata? }`; `expires` is epoch ms integer.
- Retry codes 429 and 529; max retry delay env `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS`, default 30000.
- OAuth client `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, callback port 53693, scopes `org:create_api_key user:profile`.
- No API-key rotation anywhere.
- Commit only your own task's files; do not touch `.superpowers/` and do not run `git stash`.

## Review Focus

1. Credential with no `metadata.apiKey` (older/foreign credential): re-mint instead of sending an empty key.
2. `retry-after` as an HTTP-date, `0`, negative or garbage: sane delay, never NaN, never hang.
3. 401 after key revocation: exactly one re-mint and one retry, no loop.
4. Streaming/large request body: body is not read or cloned for retry beyond what is needed; an aborted signal stops retries.
5. Refresh failure (revoked refresh token): surfaces a clear "sign in again" error, not a raw JSON dump.

## Waves

Wave 1 (parallel, disjoint files): Task 1, Task 2. Then Task 3, Task 4, Task 5 sequentially.

---

### Task 1: Credential adapter (replaces the credentials.ts model)

**Files:**
- Modify: `src/credentials.ts`, `test/credentials.test.mjs`

**Interfaces:**
- Consumes: `createApiKey(accessToken: string, fetchFn?: typeof fetch): Promise<string>` from `src/oauth.ts`.
- Produces:
  - `type OAuthCredential = { type:"oauth"; methodID:string; access:string; refresh:string; expires:number; metadata?: Record<string,unknown> }`
  - `toCredential(tokens:{access_token:string;refresh_token:string;expires_in?:number}, methodID:string, apiKey:string, now?:number): OAuthCredential` (stores `metadata.apiKey`; `expires = now + expires_in*1000`, default 3600s)
  - `apiKeyOf(cred: OAuthCredential): string | undefined`
  - `refreshCredential(cred: OAuthCredential, fetchFn?: typeof fetch): Promise<OAuthCredential>` — refreshes tokens, re-mints the key, preserves `methodID`; throws `Error("Console session expired; run /connect and sign in again")` when the token endpoint answers non-2xx.
  - `mintKey(cred, fetchFn?): Promise<OAuthCredential>` — returns a copy with a new `metadata.apiKey` (does not mutate the input).
  - `isExpiring(cred, now?): boolean` — true within 5 minutes of `expires`.
  - Removes `getOrCreateApiKey`, `_cachedApiKey`, `validateCredentialFormat`, `isOAuthTokenExpired`.

- [ ] **Step 1:** Rewrite `test/credentials.test.mjs` against the new interfaces: `toCredential` fields (including the default 3600s), `apiKeyOf` is undefined without metadata (Review Focus 1), `mintKey` does not mutate its input, `refreshCredential` keeps `methodID` and replaces access/refresh/expires/apiKey, `refreshCredential` rejects with the "sign in again" message on a 400 (Review Focus 5), `isExpiring` boundary at exactly 5 minutes. Use injected `fetchFn`.
- [ ] **Step 2:** Run `node --test test/credentials.test.mjs`; expect FAIL (missing exports).
- [ ] **Step 3:** Implement the interface above in `src/credentials.ts`; token endpoint and client id stay as constants there.
- [ ] **Step 4:** Run `node --test test/credentials.test.mjs`; expect all pass.
- [ ] **Step 5:** `git add src/credentials.ts test/credentials.test.mjs && git commit -m "refactor: adapt credentials to OpenCode OAuth credential shape"`

### Task 2: Single honest retry layer

**Files:**
- Modify: `src/http.ts`, `src/oauth.ts` (delete its private `fetchWithRetry`/`sleepUnlessAborted`/`getMaxRetryDelayMs`, import from `http.ts`)
- Create: `test/http.test.mjs`

**Interfaces:**
- Produces:
  - `parseRetryAfter(value: string | null, now?: number): number | undefined` — milliseconds; accepts integer seconds and HTTP-date; returns `undefined` for missing, negative or unparseable; `"0"` → `0`.
  - `fetchWithRetry(input, init?, retries = 3, fetchImpl = fetch): Promise<Response>` (signature unchanged). On 429/529 with a delay above the max, returns the response unchanged and logs `fetch_rate_limited_quota`.
  - `describeRateLimit(res: Response): string` — one-line message saying the limit is organization-wide, with the reset time when `retry-after` is present; used by Task 4.

- [ ] **Step 1:** Write `test/http.test.mjs`: `parseRetryAfter("7")===7000`, `("0")===0`, `("-3")`, `("abc")` and `(null)` are `undefined`, an HTTP-date 10s ahead of an injected `now` gives 10000; `fetchWithRetry` retries a 429 with `retry-after: 0` then returns 200 (call count 2); returns the 429 untouched when retry-after exceeds `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS=10` (call count 1); stops when the signal is already aborted; `describeRateLimit` text contains "organization".
- [ ] **Step 2:** `node --test test/http.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement in `src/http.ts`; the fallback delay when `parseRetryAfter` is `undefined` stays `attempt*2000`. Replace the copy in `src/oauth.ts` with the import.
- [ ] **Step 4:** `npm test`; expect all pass (oauth tests still green).
- [ ] **Step 5:** `git add src/http.ts src/oauth.ts test/http.test.mjs && git commit -m "refactor: single retry layer with retry-after date support"`

### Task 3: Register the OAuth method

**Files:**
- Modify: `src/index.ts`, `test/plugin.test.mjs`

**Interfaces:**
- Consumes: Task 1 `toCredential`, `refreshCredential`; `buildAuthorizeUrl`/`generatePKCE`/`exchangeCode`/`createApiKey`/`login` from `src/oauth.ts` (read `src/oauth.ts:99-248` for exact signatures; reuse its callback server so the method uses `mode:"auto"`).
- Produces: `INTEGRATION_ID="anthropic"`, `METHOD_ID="console"` exports (unchanged); the registration `{integrationID, method:{id,type:"oauth",label:"Anthropic Console (API usage billing)"}, authorize, refresh, label}`.

- [ ] **Step 1:** Update `test/plugin.test.mjs`: the fake `ctx.integration.transform` captures the `method.update` input; assert `method.type==="oauth"`, `method.id==="console"`, `typeof authorize==="function"`, `typeof refresh==="function"`, `typeof label==="function"`, and that `label(cred)` returns a string for a credential with `metadata.apiKey`. Assert there is no `command` property and that `authorize` results use only `mode` `"auto"` or `"code"`.
- [ ] **Step 2:** `node --test test/plugin.test.mjs`; expect FAIL (`command !== oauth`).
- [ ] **Step 3:** Implement in `src/index.ts`: `authorize` returns `{mode:"auto", url, instructions, callback}` where `callback` resolves to `toCredential(...)` after `exchangeCode` + `createApiKey`; `refresh` calls `refreshCredential`; `label` returns `"Console key …" + last 4 chars` or `undefined`. Remove the dead `ctx.provider.transform` fetch wrapping and the `login.mjs` path.
- [ ] **Step 4:** `npm test`; expect all pass.
- [ ] **Step 5:** `git add src/index.ts test/plugin.test.mjs && git commit -m "feat: register Console OAuth method with correct plugin shape"`

### Task 4: Request path via AI SDK hook

**Files:**
- Modify: `src/provider.ts`, `src/model-config.ts`, `src/index.ts` (one call to `registerConsoleRequests(ctx)`)
- Create: `test/provider.test.mjs`

**Interfaces:**
- Consumes: Task 1 `apiKeyOf`, `mintKey`, `refreshCredential`, `isExpiring`; Task 2 `fetchWithRetry`, `describeRateLimit`.
- Produces: `registerConsoleRequests(ctx: { aisdk: AISDKDomain; integration: IntegrationDomain }): Promise<void>` and `createConsoleFetch(getCredential: () => Promise<OAuthCredential | undefined>, save: (c: OAuthCredential) => Promise<void>, base?: typeof fetch): typeof fetch`.

- [ ] **Step 1 (verify the hook):** Read `node_modules/@opencode/plugin/dist/promise/aisdk.d.ts`, `registration.d.ts` and the `@opencode/plugin` README to confirm that `ctx.aisdk.hook("sdk", cb)` receives mutable `options` and that `options.fetch` is honoured for the `anthropic` package. Record the finding as a comment at the top of `src/provider.ts`. If no credential persistence API exists for `save`, use `ctx.integration.connection.status` to report "sign in required" and keep the refreshed credential in memory for the process. If the hook cannot carry a custom fetch, stop and report instead of improvising.
- [ ] **Step 2:** Write `test/provider.test.mjs` with an injected `base` fetch: injects `x-api-key` from `metadata.apiKey` and removes any existing `x-api-key`; no apiKey in the credential → mints one before the first call (Review Focus 1); an `isExpiring` credential is refreshed once before the call; a 401 triggers exactly one `mintKey` and one retry, and a second 401 is returned (Review Focus 3); a 429 with `retry-after` above the max returns the 429 with base call count 1; a string/stream `init.body` reaches `base` unchanged (Review Focus 4).
- [ ] **Step 3:** `node --test test/provider.test.mjs`; expect FAIL.
- [ ] **Step 4:** Implement the interfaces; delete `prepareConsoleRequest`/`sendWithRetry`/`handleResponse` if unused afterwards. Keep `buildRequestHeaders` for the user-agent and `x-app` identity headers and remove `Authorization: Bearer`.
- [ ] **Step 5:** `npm test`; expect all pass.
- [ ] **Step 6:** `git add src test && git commit -m "feat: inject Console key and retry via AI SDK hook"`

### Task 5: Cleanup and docs

**Files:**
- Delete: `src/login.mjs`
- Modify: `README.md`, `package.json` (pin `@opencode/plugin` to `^2.2.1`), `package-lock.json`

- [ ] **Step 1:** `git rm src/login.mjs`; run `grep -rn login.mjs . --exclude-dir=node_modules --exclude-dir=.git` and fix remaining references.
- [ ] **Step 2:** Rewrite the README "How it works" and "Rate limiting" sections for the OAuth flow; state plainly that keys from one org share a quota, and that the plugin retries per `retry-after` but cannot bypass org limits.
- [ ] **Step 3:** `npm test`; expect all pass. `git status` should be clean apart from `.superpowers/`.
- [ ] **Step 4:** `git add -A src README.md package.json package-lock.json && git commit -m "chore: remove command login and document OAuth flow"`
