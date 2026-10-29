# Task 1 Brief: Port oauth.mjs to TypeScript (oauth.ts)

**Context:** You're porting the existing OAuth flow from `src/oauth.mjs` (JavaScript) to `src/oauth.ts` (TypeScript) with minimal logic changes. This is a mechanical refactor to add types before later tasks build on it.

**Files involved:**
- Create: `src/oauth.ts` (from oauth.mjs, with TypeScript annotations)
- Delete: `src/oauth.mjs` (no longer needed)
- Modify: `test/oauth.test.mjs` (update imports)

**Interfaces you produce:**
- Export all the same functions as oauth.mjs, now with types:
  - `generatePKCE(): Promise<{ verifier: string; challenge: string }>`
  - `buildAuthorizeUrl({ challenge, state, redirectUri }): string`
  - `exchangeCode({ code, state, verifier, redirectUri, fetchFn }): Promise<string>` — returns access_token
  - `createApiKey(oauthAccessToken, fetchFn): Promise<string>` — returns raw_key
  - `parseAuthorizationInput(input): { code?: string; state?: string }`
  - `login(options?): Promise<string>` — interactive flow, returns raw_key
  - OAuth constants: `CLIENT_ID`, `CALLBACK_PORT`, `AUTHORIZE_URL`, `TOKEN_URL`, `API_KEY_URL`, `SCOPES`, `REDIRECT_URI`

**Steps:**
1. Copy `src/oauth.mjs` to `src/oauth.ts`
2. Add TypeScript type signatures to all function parameters and return types
3. Update test import in `test/oauth.test.mjs`
4. Run tests to verify logic unchanged
5. Commit

**Key constraint:** No logic changes, only type annotations. Tests must pass unchanged.
