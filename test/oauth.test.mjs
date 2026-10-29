import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  buildAuthorizeUrl,
  CALLBACK_PORT,
  createApiKey,
  exchangeCode,
  generatePKCE,
  login,
  parseAuthorizationInput,
} from "../src/oauth.ts"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

test("generatePKCE returns a verifier and its S256 challenge", async () => {
  const { verifier, challenge } = await generatePKCE()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"))
})

test("parseAuthorizationInput reads a redirect URL", () => {
  assert.deepEqual(parseAuthorizationInput("http://localhost:53693/callback?code=abc&state=xyz"), {
    code: "abc",
    state: "xyz",
  })
})

test("parseAuthorizationInput reads code#state", () => {
  assert.deepEqual(parseAuthorizationInput(" abc#xyz "), { code: "abc", state: "xyz" })
})

test("parseAuthorizationInput reads a query string", () => {
  assert.deepEqual(parseAuthorizationInput("code=abc&state=xyz"), { code: "abc", state: "xyz" })
})

test("parseAuthorizationInput treats a bare value as the code and ignores empty input", () => {
  assert.deepEqual(parseAuthorizationInput("abc"), { code: "abc" })
  assert.deepEqual(parseAuthorizationInput("  "), {})
})

test("buildAuthorizeUrl targets the Console with PKCE and the key-creation scope", () => {
  const url = new URL(buildAuthorizeUrl({ challenge: "c", state: "s", redirectUri: "http://localhost:1/callback" }))
  assert.equal(url.origin + url.pathname, "https://platform.claude.com/oauth/authorize")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("scope"), "org:create_api_key user:profile")
  assert.equal(url.searchParams.get("code_challenge"), "c")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("state"), "s")
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1/callback")
})

test("exchangeCode posts the authorization code grant and returns the access token", async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ access_token: "oauth-access", refresh_token: "r", expires_in: 3600 })
  }
  const token = await exchangeCode({ code: "abc", state: "s", verifier: "v", redirectUri: "http://x/cb", fetchFn })
  assert.equal(token, "oauth-access")
  assert.equal(calls[0].url, "https://platform.claude.com/v1/oauth/token")
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: "authorization_code",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    code: "abc",
    state: "s",
    redirect_uri: "http://x/cb",
    code_verifier: "v",
  })
})

test("exchangeCode reports the response body on failure", async () => {
  const fetchFn = async () => new Response("nope", { status: 400 })
  await assert.rejects(
    exchangeCode({ code: "a", state: "s", verifier: "v", redirectUri: "u", fetchFn }),
    /Token exchange failed: nope/,
  )
})

test("createApiKey returns the raw key", async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ raw_key: "sk-ant-api03-abc" })
  }
  assert.equal(await createApiKey("oauth-access", fetchFn), "sk-ant-api03-abc")
  assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/claude_cli/create_api_key")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.Authorization, "Bearer oauth-access")
})

test("createApiKey fails when no key is returned", async () => {
  const fetchFn = async () => jsonResponse({})
  await assert.rejects(createApiKey("t", fetchFn), /no key/)
})

test("login completes through the local callback and returns the API key", async () => {
  const fetchFn = async (url) =>
    url.endsWith("/v1/oauth/token")
      ? jsonResponse({ access_token: "oauth-access", refresh_token: "r", expires_in: 3600 })
      : jsonResponse({ raw_key: "sk-ant-api03-abc" })

  const key = await login({
    fetchFn,
    log: () => {},
    openUrl: async (authUrl) => {
      const params = new URL(authUrl).searchParams
      const callback = new URL(params.get("redirect_uri"))
      callback.searchParams.set("code", "abc")
      callback.searchParams.set("state", params.get("state"))
      const response = await fetch(callback)
      assert.equal(response.status, 200)
    },
  })

  assert.equal(key, "sk-ant-api03-abc")
})

test("login rejects a callback whose state does not match", async () => {
  await assert.rejects(
    login({
      fetchFn: async () => jsonResponse({}),
      log: () => {},
      timeoutMs: 300,
      openUrl: async (authUrl) => {
        const callback = new URL(new URL(authUrl).searchParams.get("redirect_uri"))
        callback.searchParams.set("code", "abc")
        callback.searchParams.set("state", "wrong")
        const response = await fetch(callback)
        assert.equal(response.status, 400)
      },
    }),
    /Timed out/,
  )
})

test("callback port is fixed so the redirect URI stays registered", () => {
  assert.equal(CALLBACK_PORT, 53693)
})

test("a rate-limited authorization code is exchanged once, matching Pi", async () => {
  let calls = 0
  const fetchFn = async () => {
    calls++
    return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }), {
      status: 429, headers: { "retry-after": "0", "request-id": "req-oauth-test" },
    })
  }
  await assert.rejects(exchangeCode({ code: "single-use-code", state: "s", verifier: "v", redirectUri: "u", fetchFn }), /rate_limit_error/)
  assert.equal(calls, 1)
})

test("token exchange errors include upstream status, retry delay and request ID", async () => {
  const fetchFn = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited" } }), {
    status: 429, headers: { "retry-after": "3600", "request-id": "req-oauth-test" },
  })
  await assert.rejects(exchangeCode({ code: "code", state: "s", verifier: "v", redirectUri: "u", fetchFn }), (error) => {
    assert.match(error.message, /HTTP 429/)
    assert.match(error.message, /3600/)
    assert.match(error.message, /req-oauth-test/)
    assert.doesNotMatch(error.message, /single-use-code|code_verifier/)
    return true
  })
})
